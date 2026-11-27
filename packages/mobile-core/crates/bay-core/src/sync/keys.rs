//! A sync chain's keys, as SyncCrypto.swift makes them, so a phone and a computer read each other's files. From the
//! chain's 32 random bytes (the recovery phrase's entropy), HKDF-SHA256 with the salt `bay-sync/v1` gives the file
//! key (AES-256-GCM over each file, its chain, scope and name bound in as associated data) and the name key
//! (HMAC-SHA256 of a label, the first 16 bytes in base32). The relay secret proves to the relay that a device holds
//! the key; the relay keeps only its SHA-256. A port of `packages/sync/src/relay/keys.ts`.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use zeroize::Zeroizing;

use super::bytes::{base32, base64url};

const MAGIC: &[u8] = b"NNS1";
const SALT: &[u8] = b"bay-sync/v1";
const PADDING: usize = 1024;
pub(crate) const NONCE: usize = 12;
const TAG: usize = 16;

/// Why a file didn't open: it isn't a sealed file, or it was changed, moved or sealed with another key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SealError {
    #[error("Not a sync file")]
    Format,
    #[error("A sync file didn't open with this key")]
    Authentication,
}

/// Random bytes from the operating system.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).expect("the system has randomness");
    bytes
}

pub(crate) fn hkdf32(ikm: &[u8], salt: Option<&[u8]>, info: &[u8]) -> [u8; 32] {
    let mut out = [0; 32];
    Hkdf::<Sha256>::new(salt, ikm)
        .expand(info, &mut out)
        .expect("32 bytes is a valid HKDF length");
    out
}

pub(crate) fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut mac =
        <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(message);
    mac.finalize().into_bytes().into()
}

pub(crate) fn seal_gcm(key: &[u8; 32], nonce: &[u8], aad: &[u8], plain: &[u8]) -> Vec<u8> {
    let cipher = Aes256Gcm::new(key.into());
    let nonce = Nonce::try_from(nonce).expect("a 12-byte nonce");
    cipher
        .encrypt(&nonce, Payload { msg: plain, aad })
        .expect("AES-GCM seals any length this code gives it")
}

pub(crate) fn open_gcm(key: &[u8; 32], nonce: &[u8], aad: &[u8], sealed: &[u8]) -> Option<Vec<u8>> {
    let cipher = Aes256Gcm::new(key.into());
    let nonce = Nonce::try_from(nonce).ok()?;
    cipher.decrypt(&nonce, Payload { msg: sealed, aad }).ok()
}

pub struct SyncKeys {
    entropy: Zeroizing<[u8; 32]>,
    file_key: Zeroizing<[u8; 32]>,
    name_key: Zeroizing<[u8; 32]>,
    /// The bearer secret a relay knows this chain by.
    pub relay_secret: String,
    pub chain_tag: String,
}

impl SyncKeys {
    pub fn new(entropy: [u8; 32]) -> Self {
        let file_key = Zeroizing::new(hkdf32(&entropy, Some(SALT), b"file-key"));
        let name_key = Zeroizing::new(hkdf32(&entropy, Some(SALT), b"name-key"));
        let relay_secret = base64url(&hkdf32(&entropy, Some(SALT), b"relay-auth"));
        let chain_tag = base32(&hmac_sha256(&*name_key, b"chain")[..16]);
        Self {
            entropy: Zeroizing::new(entropy),
            file_key,
            name_key,
            relay_secret,
            chain_tag,
        }
    }

    /// The chain's 32 bytes: the recovery phrase's entropy.
    pub fn entropy(&self) -> &[u8; 32] {
        &self.entropy
    }

    pub fn scope_tag(&self, scope: &str) -> String {
        base32(&hmac_sha256(&*self.name_key, format!("scope/{scope}").as_bytes())[..16])
    }

    fn associated_data(&self, scope_tag: &str, file_id: &str) -> Vec<u8> {
        [
            MAGIC,
            format!("{}/{scope_tag}/{file_id}", self.chain_tag).as_bytes(),
        ]
        .concat()
    }

    /// A new file's name: 16 random bytes in base32.
    pub fn new_file_id() -> String {
        base32(&random_bytes::<16>())
    }

    /// A payload sealed as a sync file: its length, the payload, zeros to the next kilobyte (so sizes say little), all
    /// AES-GCM sealed under the file key, the tag after the ciphertext.
    pub fn seal(&self, payload: &[u8], scope_tag: &str, file_id: &str) -> Vec<u8> {
        self.seal_with_nonce(payload, scope_tag, file_id, &random_bytes::<NONCE>())
    }

    pub fn seal_with_nonce(
        &self,
        payload: &[u8],
        scope_tag: &str,
        file_id: &str,
        nonce: &[u8; NONCE],
    ) -> Vec<u8> {
        let length = 4 + payload.len();
        let mut plain = Vec::with_capacity(length + PADDING);
        plain.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        plain.extend_from_slice(payload);
        plain.resize(length + (PADDING - length % PADDING) % PADDING, 0);
        let sealed = seal_gcm(
            &self.file_key,
            nonce,
            &self.associated_data(scope_tag, file_id),
            &plain,
        );
        [MAGIC, nonce, &sealed].concat()
    }

    pub fn open(&self, file: &[u8], scope_tag: &str, file_id: &str) -> Result<Vec<u8>, SealError> {
        if file.len() < MAGIC.len() + NONCE + TAG + 4 || !file.starts_with(MAGIC) {
            return Err(SealError::Format);
        }
        let nonce = &file[MAGIC.len()..MAGIC.len() + NONCE];
        let plain = open_gcm(
            &self.file_key,
            nonce,
            &self.associated_data(scope_tag, file_id),
            &file[MAGIC.len() + NONCE..],
        )
        .ok_or(SealError::Authentication)?;
        let length =
            u32::from_be_bytes(plain[..4].try_into().map_err(|_| SealError::Format)?) as usize;
        if length > plain.len() - 4 {
            return Err(SealError::Format);
        }
        Ok(plain[4..4 + length].to_vec())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::Value;

    pub(crate) fn golden() -> Value {
        serde_json::from_str(include_str!("../../../../../sync/fixtures/golden.json")).unwrap()
    }

    pub(crate) fn hex(value: &Value) -> Vec<u8> {
        hex::decode(value.as_str().unwrap()).unwrap()
    }

    fn keys() -> SyncKeys {
        SyncKeys::new(hex(&golden()["entropy"]).try_into().unwrap())
    }

    #[test]
    fn the_chain_and_scope_names_are_the_macs() {
        let golden = golden();
        let keys = keys();
        assert_eq!(keys.chain_tag, golden["chainTag"]);
        assert_eq!(
            keys.scope_tag(golden["scope"].as_str().unwrap()),
            golden["scopeTag"]
        );
    }

    #[test]
    fn a_file_sealed_here_is_byte_for_byte_cryptokits_and_the_macs_opens_here() {
        let golden = golden();
        let keys = keys();
        let (scope_tag, file_id) = (
            golden["scopeTag"].as_str().unwrap(),
            golden["fileId"].as_str().unwrap(),
        );
        let nonce: [u8; NONCE] = hex(&golden["nonce"]).try_into().unwrap();
        let sealed = keys.seal_with_nonce(
            golden["payload"].as_str().unwrap().as_bytes(),
            scope_tag,
            file_id,
            &nonce,
        );
        assert_eq!(sealed, hex(&golden["sealed"]));
        assert_eq!(
            keys.open(&hex(&golden["sealed"]), scope_tag, file_id)
                .unwrap(),
            golden["payload"].as_str().unwrap().as_bytes()
        );
    }

    #[test]
    fn a_changed_or_moved_file_does_not_open() {
        let golden = golden();
        let keys = keys();
        let (scope_tag, file_id) = (
            golden["scopeTag"].as_str().unwrap(),
            golden["fileId"].as_str().unwrap(),
        );
        let sealed = hex(&golden["sealed"]);
        for at in [0, 20, sealed.len() - 1] {
            let mut changed = sealed.clone();
            changed[at] ^= 1;
            assert!(keys.open(&changed, scope_tag, file_id).is_err());
        }
        assert_eq!(
            keys.open(&sealed, &keys.scope_tag("another-profile"), file_id),
            Err(SealError::Authentication)
        );
        assert_eq!(
            keys.open(&sealed, scope_tag, "zzzzzzzzzzzzzzzzzzzzzzzzzz"),
            Err(SealError::Authentication)
        );
    }

    #[test]
    fn a_fresh_file_is_padded_to_a_kilobyte() {
        let keys = keys();
        let id = SyncKeys::new_file_id();
        let sealed = keys.seal(b"hello", "scope", &id);
        assert_eq!(sealed.len(), 4 + 12 + 1024 + 16);
        assert_eq!(keys.open(&sealed, "scope", &id).unwrap(), b"hello");
    }
}
