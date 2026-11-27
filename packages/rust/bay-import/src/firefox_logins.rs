//! Firefox's saved logins (Zen's too) without NSS: the login key from key4.db, opened with the primary password (empty
//! when none is set), decrypts each field of logins.json. The same steps as NSS's softoken (sftkdb_passwordToKey,
//! PBES2 or the legacy SHA-1/3DES PBE), so no installed Firefox library is needed on any desktop.

use std::path::Path;

use aes::Aes256;
use aes::cipher::{BlockCipherDecrypt, KeyInit};
use des::TdesEde3;
use hmac::{Hmac, Mac};
use serde_json::{Map, Value, json};
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha384, Sha512};

use crate::failure::{Failure, Result};
use crate::readers::Cancel;
use crate::snapshot::Snapshot;

const PBES2: &str = "1.2.840.113549.1.5.13";
const PBKDF2: &str = "1.2.840.113549.1.5.12";
const SHA1_AND_3DES: &str = "1.2.840.113549.1.12.5.1.3";
const AES256_CBC: &str = "2.16.840.1.101.3.4.1.42";
const DES3_CBC: &str = "1.2.840.113549.3.7";
/// The CKA_ID of the login key NSS stores (`f8 00…00 01`).
const LOGIN_KEY_ID: [u8; 16] = [0xF8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01];

/// One DER value: its tag, its content and, for a constructed one, what it holds.
struct Der {
    tag: u8,
    content: Vec<u8>,
    children: Vec<Der>,
}

impl Der {
    fn parse(data: &[u8]) -> Result<Der> {
        let mut at = 0;
        Self::read(data, &mut at, 0)
    }

    fn read(data: &[u8], at: &mut usize, depth: usize) -> Result<Der> {
        let truncated = || Failure::new("unreadable", "Truncated DER");
        if depth >= 16 || *at + 2 > data.len() {
            return Err(truncated());
        }
        let tag = data[*at];
        let mut length = data[*at + 1] as usize;
        *at += 2;
        if length & 0x80 != 0 {
            let count = length & 0x7F;
            if count == 0 || count > 4 || *at + count > data.len() {
                return Err(Failure::new("unreadable", "Bad DER length"));
            }
            length = data[*at..*at + count]
                .iter()
                .fold(0, |value, byte| value << 8 | *byte as usize);
            *at += count;
        }
        if *at + length > data.len() {
            return Err(truncated());
        }
        let content = data[*at..*at + length].to_vec();
        *at += length;
        let mut children = Vec::new();
        if tag & 0x20 != 0 {
            let mut inner = 0;
            while inner < content.len() {
                children.push(Self::read(&content, &mut inner, depth + 1)?);
            }
        }
        Ok(Der {
            tag,
            content,
            children,
        })
    }

    fn child(&self, index: usize) -> Option<&Der> {
        self.children.get(index)
    }

    fn oid(&self) -> Option<String> {
        let (first, rest) = self.content.split_first().filter(|_| self.tag == 0x06)?;
        let mut parts = vec![(*first / 40) as u64, (*first % 40) as u64];
        let mut value = 0u64;
        for byte in rest {
            value = value << 7 | (*byte & 0x7F) as u64;
            if byte & 0x80 == 0 {
                parts.push(value);
                value = 0;
            }
        }
        Some(
            parts
                .iter()
                .map(u64::to_string)
                .collect::<Vec<_>>()
                .join("."),
        )
    }

    fn integer(&self) -> usize {
        self.content
            .iter()
            .fold(0, |value, byte| value << 8 | *byte as usize)
    }
}

/// CBC without unpadding; `None` for a key, IV or input of the wrong size.
fn cbc_decrypt<C: BlockCipherDecrypt + KeyInit>(
    input: &[u8],
    key: &[u8],
    iv: &[u8],
) -> Option<Vec<u8>> {
    let size = C::block_size();
    if input.is_empty() || !input.len().is_multiple_of(size) || iv.len() != size {
        return None;
    }
    let cipher = C::new_from_slice(key).ok()?;
    let mut previous = iv.to_vec();
    let mut plain = Vec::with_capacity(input.len());
    for chunk in input.chunks(size) {
        let mut block = aes::cipher::Block::<C>::try_from(chunk).ok()?;
        cipher.decrypt_block(&mut block);
        plain.extend(block.iter().zip(&previous).map(|(byte, mask)| byte ^ mask));
        previous.copy_from_slice(chunk);
    }
    Some(plain)
}

fn padding(data: &[u8], size: usize) -> Option<usize> {
    let pad = *data.last()? as usize;
    (pad > 0
        && pad <= size
        && pad <= data.len()
        && data[data.len() - pad..]
            .iter()
            .all(|byte| *byte as usize == pad))
    .then_some(pad)
}

/// PKCS#7 padding off, or `None` when it doesn't check out.
fn unpad(mut data: Vec<u8>, size: usize) -> Option<Vec<u8>> {
    let pad = padding(&data, size)?;
    data.truncate(data.len() - pad);
    Some(data)
}

/// Padding off when it checks out, else the data as it is (NSS's key entries aren't always padded).
fn unpad_leniently(mut data: Vec<u8>, size: usize) -> Vec<u8> {
    if let Some(pad) = padding(&data, size) {
        data.truncate(data.len() - pad);
    }
    data
}

/// NSS hashes the global salt and password with the hash as long as the salt (sftkdb_passwordToKey): SHA-1 for the
/// 20-byte salt every key4.db had, SHA-384 for the 48-byte one NSS now writes when a primary password is set.
fn password_hash(data: &[u8], salt_length: usize) -> Vec<u8> {
    match salt_length {
        32 => Sha256::digest(data).to_vec(),
        48 => Sha384::digest(data).to_vec(),
        64 => Sha512::digest(data).to_vec(),
        _ => Sha1::digest(data).to_vec(),
    }
}

fn hmac_sha1(key: &[u8], message: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha1>::new_from_slice(key).expect("HMAC takes any key");
    mac.update(message);
    mac.finalize().into_bytes().to_vec()
}

fn pbkdf2_sha256(password: &[u8], salt: &[u8], rounds: usize, length: usize) -> Vec<u8> {
    let mut out = vec![0u8; length];
    for (index, block) in out.chunks_mut(32).enumerate() {
        let mut mac = Hmac::<Sha256>::new_from_slice(password).expect("HMAC takes any key");
        mac.update(salt);
        mac.update(&(index as u32 + 1).to_be_bytes());
        let mut u = mac.finalize().into_bytes().to_vec();
        let mut t = u.clone();
        for _ in 1..rounds {
            let mut mac = Hmac::<Sha256>::new_from_slice(password).expect("HMAC takes any key");
            mac.update(&u);
            u = mac.finalize().into_bytes().to_vec();
            t.iter_mut().zip(&u).for_each(|(a, b)| *a ^= b);
        }
        block.copy_from_slice(&t[..block.len()]);
    }
    out
}

/// The legacy PBE (PKCS#12 SHA-1 and 3DES): key and IV from the global salt, the password and the entry's salt.
fn legacy_3des_key(global_salt: &[u8], password: &[u8], entry_salt: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let hp = Sha1::digest([global_salt, password].concat()).to_vec();
    let mut pes = entry_salt.to_vec();
    pes.resize(entry_salt.len().max(20), 0);
    let chp = Sha1::digest([&hp[..], entry_salt].concat()).to_vec();
    let k1 = hmac_sha1(&chp, &[&pes[..], entry_salt].concat());
    let tk = hmac_sha1(&chp, &pes);
    let k2 = hmac_sha1(&chp, &[&tk[..], entry_salt].concat());
    let k = [k1, k2].concat();
    (k[..24].to_vec(), k[k.len() - 8..].to_vec())
}

fn unexpected(what: &str) -> Failure {
    Failure::new("unreadable", format!("Unexpected {what}"))
}

/// An encrypted key4.db entry opened with the global salt and the primary password.
fn decrypt_pbe(node: &Der, global_salt: &[u8], password: &[u8]) -> Result<Vec<u8>> {
    let algorithm = node.child(0).ok_or_else(|| unexpected("PBE structure"))?;
    let oid = algorithm
        .child(0)
        .and_then(Der::oid)
        .ok_or_else(|| unexpected("PBE structure"))?;
    let params = algorithm
        .child(1)
        .ok_or_else(|| unexpected("PBE structure"))?;
    let cipher = &node
        .child(1)
        .ok_or_else(|| unexpected("PBE structure"))?
        .content;
    match oid.as_str() {
        PBES2 => {
            let kdf = params
                .child(0)
                .ok_or_else(|| unexpected("PBES2 parameters"))?;
            if kdf.child(0).and_then(Der::oid).as_deref() != Some(PBKDF2) {
                return Err(unexpected("PBES2 parameters"));
            }
            let kdf = kdf
                .child(1)
                .filter(|kdf| kdf.children.len() >= 3)
                .ok_or_else(|| unexpected("PBES2 parameters"))?;
            let iv_tail = params
                .child(1)
                .and_then(|scheme| scheme.child(1))
                .ok_or_else(|| unexpected("PBES2 parameters"))?;
            let iterations = kdf.children[1].integer();
            let key_length = kdf.children[2].integer();
            if iterations == 0 || key_length != 32 {
                return Err(Failure::new("unsupported", "Unsupported PBES2 key size"));
            }
            let hashed = password_hash(&[global_salt, password].concat(), global_salt.len());
            let key = pbkdf2_sha256(&hashed, &kdf.children[0].content, iterations, key_length);
            // NSS stores 14 IV bytes; the DER length prefix supplies the missing two.
            let iv = [&[0x04, 0x0E][..], &iv_tail.content].concat();
            let clear = cbc_decrypt::<Aes256>(cipher, &key, &iv)
                .ok_or_else(|| Failure::new("locked", "PBES2 decryption failed"))?;
            Ok(unpad_leniently(clear, 16))
        }
        SHA1_AND_3DES => {
            let salt = &params
                .child(0)
                .ok_or_else(|| unexpected("3DES PBE parameters"))?
                .content;
            let (key, iv) = legacy_3des_key(global_salt, password, salt);
            let clear = cbc_decrypt::<TdesEde3>(cipher, &key, &iv)
                .ok_or_else(|| Failure::new("locked", "3DES PBE decryption failed"))?;
            Ok(unpad_leniently(clear, 8))
        }
        other => Err(Failure::new(
            "unsupported",
            format!("Unsupported PBE algorithm {other}"),
        )),
    }
}

fn blob(row: &rusqlite::Row<'_>, column: usize) -> Option<Vec<u8>> {
    match row.get_ref(column).ok()? {
        rusqlite::types::ValueRef::Blob(bytes) | rusqlite::types::ValueRef::Text(bytes) => {
            Some(bytes.to_vec())
        }
        _ => None,
    }
}

/// The profile's login key: key4.db's, opened with the primary password.
pub fn firefox_master_key(key4: &Path, primary_password: &str) -> Result<Vec<u8>> {
    let db = Snapshot::open(key4)?;
    if !db.table("metaData")? || !db.table("nssPrivate")? {
        return Err(Failure::new(
            "unsupported",
            "key4.db has an unexpected layout",
        ));
    }
    let mut entry = None;
    db.query(
        "SELECT item1, item2 FROM metaData WHERE id = 'password'",
        |row| {
            entry = blob(row, 0).zip(blob(row, 1));
            Ok(false)
        },
    )?;
    let (global_salt, check) =
        entry.ok_or_else(|| Failure::new("unreadable", "key4.db has no password entry"))?;
    let password = primary_password.as_bytes();
    let checked = Der::parse(&check)
        .and_then(|node| decrypt_pbe(&node, &global_salt, password))
        .is_ok_and(|clear| clear.starts_with(b"password-check"));
    if !checked {
        return Err(Failure::new("locked", "Wrong Firefox primary password"));
    }
    let mut encrypted = None;
    db.query("SELECT a11, a102 FROM nssPrivate", |row| {
        let Some(a11) = blob(row, 0) else {
            return Ok(true);
        };
        let login = blob(row, 1).as_deref() == Some(&LOGIN_KEY_ID[..]);
        if encrypted.is_none() || login {
            encrypted = Some(a11);
        }
        Ok(!login)
    })?;
    let encrypted =
        encrypted.ok_or_else(|| Failure::new("unreadable", "key4.db holds no login key"))?;
    let key = decrypt_pbe(&Der::parse(&encrypted)?, &global_salt, password)?;
    if key.len() < 24 {
        return Err(Failure::new("unreadable", "key4.db login key is malformed"));
    }
    Ok(key)
}

fn base64(text: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut buffer, mut bits) = (0u32, 0u32);
    for byte in text.bytes().filter(|byte| !byte.is_ascii_whitespace()) {
        if byte == b'=' {
            break;
        }
        let index = ALPHABET.iter().position(|c| *c == byte)? as u32;
        buffer = buffer << 6 | index;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// One encrypted logins.json field, or `None` when it doesn't open.
fn decrypt_field(text: &str, key: &[u8]) -> Option<String> {
    let node = Der::parse(&base64(text)?).ok()?;
    let algorithm = node.child(1)?;
    let iv = &algorithm.child(1)?.content;
    let cipher = &node.child(2)?.content;
    let plain = match algorithm.child(0)?.oid()?.as_str() {
        DES3_CBC => unpad(cbc_decrypt::<TdesEde3>(cipher, key.get(..24)?, iv)?, 8)?,
        AES256_CBC => unpad(cbc_decrypt::<Aes256>(cipher, key.get(..32)?, iv)?, 16)?,
        _ => return None,
    };
    String::from_utf8(plain).ok()
}

/// The credentials in logins.json, opened with the login key; a field that doesn't open skips its login.
pub fn firefox_logins_from_json(json: &str, key: &[u8], cancel: Cancel<'_>) -> Result<Value> {
    let top: Value = serde_json::from_str(json)
        .map_err(|_| Failure::new("unreadable", "logins.json is malformed"))?;
    let rows = top
        .get("logins")
        .and_then(Value::as_array)
        .ok_or_else(|| Failure::new("unreadable", "logins.json is malformed"))?;
    let mut out = Vec::new();
    for row in rows {
        cancel.check()?;
        let text = |name: &str| row.get(name).and_then(Value::as_str);
        let Some(host) = text("hostname") else {
            continue;
        };
        let Some(username) = text("encryptedUsername").and_then(|field| decrypt_field(field, key))
        else {
            continue;
        };
        let Some(password) = text("encryptedPassword")
            .and_then(|field| decrypt_field(field, key))
            .filter(|password| !password.is_empty())
        else {
            continue;
        };
        let mut credential = Map::new();
        credential.insert(
            "url".into(),
            json!(
                text("formSubmitURL")
                    .filter(|url| !url.is_empty())
                    .unwrap_or(host)
            ),
        );
        credential.insert("username".into(), json!(username));
        credential.insert("password".into(), json!(password));
        credential.insert("realm".into(), json!(text("httpRealm").unwrap_or(host)));
        for (from, to) in [("timeCreated", "created"), ("timeLastUsed", "lastUsed")] {
            if let Some(time) = row.get(from).and_then(Value::as_f64) {
                credential.insert(to.into(), json!(time));
            }
        }
        if let Some(times) = row.get("timesUsed").and_then(Value::as_i64) {
            credential.insert("timesUsed".into(), json!(times));
        }
        out.push(Value::Object(credential));
    }
    Ok(Value::Array(out))
}

/// A Firefox (or Zen) profile's saved logins, opened with its primary password (empty when none is set).
pub fn firefox_logins(profile: &Path, primary_password: &str, cancel: Cancel<'_>) -> Result<Value> {
    let logins = profile.join("logins.json");
    let key4 = profile.join("key4.db");
    if !logins.exists() {
        return Err(Failure::new("notFound", "No saved logins in this profile"));
    }
    if !key4.exists() {
        return Err(Failure::new("unsupported", "This profile has no key4.db"));
    }
    let key = firefox_master_key(&key4, primary_password)?;
    let json = std::fs::read_to_string(&logins)
        .map_err(|_| Failure::new("unreadable", "Could not read logins.json"))?;
    firefox_logins_from_json(&json, &key, cancel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;

    static NOT_CANCELLED: AtomicBool = AtomicBool::new(false);

    fn read(profile: &Path, password: &str) -> Result<Value> {
        firefox_logins(profile, password, Cancel(&NOT_CANCELLED))
    }

    fn fixture(path: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../import/fixtures")
            .join(path)
    }

    fn firefox(profile: &str) -> PathBuf {
        fixture("home/Library/Application Support/Firefox/Profiles").join(profile)
    }

    fn field(logins: &Value, name: &str) -> Vec<String> {
        let mut values: Vec<String> = logins
            .as_array()
            .unwrap()
            .iter()
            .map(|login| login[name].as_str().unwrap().to_owned())
            .collect();
        values.sort();
        values
    }

    #[test]
    fn a_profile_without_a_primary_password_opens() {
        let logins = read(&firefox("abcd1234.default-release"), "").unwrap();
        assert_eq!(logins.as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_primary_password_opens_its_profile_only() {
        let profile = firefox("zzzz9999.work");
        assert_eq!(read(&profile, "").unwrap_err().code, "locked");
        let logins = read(&profile, "hunter2").unwrap();
        assert_eq!(field(&logins, "password"), ["aes-protected"]);
    }

    // Zen 1.22 keeps a 48-byte global salt, hashed with SHA-384, once a primary password is set.
    #[test]
    fn a_sha384_salted_primary_password_opens() {
        let profile = fixture("zen-primary");
        let logins = read(&profile, "work-primary").unwrap();
        assert_eq!(
            field(&logins, "username"),
            ["work@corp.example", "work@corp.example"]
        );
        assert_eq!(
            field(&logins, "password"),
            ["figma-fake-5", "linear-fake-4"]
        );
        for wrong in ["nope", ""] {
            assert_eq!(read(&profile, wrong).unwrap_err().code, "locked");
        }
    }

    #[test]
    fn pbkdf2_matches_rfc_7914() {
        let key = pbkdf2_sha256(b"passwd", b"salt", 1, 64);
        assert_eq!(key[..8], [0x55, 0xac, 0x04, 0x6e, 0x56, 0xe3, 0x08, 0x9f]);
    }
}
