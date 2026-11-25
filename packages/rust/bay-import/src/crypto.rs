//! Chromium's encrypted values as macOS keeps them: `v10`, then AES-128-CBC (IV of sixteen spaces, PKCS#7 padding)
//! under a key the host derives from the browser's Safe Storage secret.

use aes::Aes128;
use aes::cipher::{BlockCipherDecrypt, KeyInit};

const PREFIX: &[u8] = b"v10";
const BLOCK: usize = 16;

/// A `v10` value decrypted with a 16-byte key; `None` when it isn't one, the key is wrong length, or the padding
/// doesn't check out (often, though not always, a wrong key).
pub fn decrypt_cbc(value: &[u8], key: &[u8]) -> Option<Vec<u8>> {
    let body = value.strip_prefix(PREFIX)?;
    if key.len() != BLOCK || body.is_empty() || !body.len().is_multiple_of(BLOCK) {
        return None;
    }
    let cipher = Aes128::new_from_slice(key).ok()?;
    let mut previous = [b' '; BLOCK];
    let mut plain = Vec::with_capacity(body.len());
    for chunk in body.as_chunks::<BLOCK>().0 {
        let mut block = aes::Block::from(*chunk);
        cipher.decrypt_block(&mut block);
        plain.extend(block.iter().zip(previous).map(|(byte, mask)| byte ^ mask));
        previous.copy_from_slice(chunk);
    }
    let pad = *plain.last()? as usize;
    if pad == 0
        || pad > BLOCK
        || !plain[plain.len() - pad..]
            .iter()
            .all(|byte| *byte as usize == pad)
    {
        return None;
    }
    plain.truncate(plain.len() - pad);
    Some(plain)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockCipherEncrypt;

    fn encrypt(plain: &[u8], key: &[u8; 16]) -> Vec<u8> {
        let cipher = Aes128::new(key.into());
        let pad = BLOCK - plain.len() % BLOCK;
        let mut padded = plain.to_vec();
        padded.extend(std::iter::repeat_n(pad as u8, pad));
        let mut out = PREFIX.to_vec();
        let mut previous = [b' '; BLOCK];
        for chunk in padded.as_chunks::<BLOCK>().0 {
            let mut block = aes::Block::default();
            for (i, byte) in block.iter_mut().enumerate() {
                *byte = chunk[i] ^ previous[i];
            }
            cipher.encrypt_block(&mut block);
            previous.copy_from_slice(&block);
            out.extend_from_slice(&block);
        }
        out
    }

    #[test]
    fn v10_values_open_with_their_key_only() {
        let key = [7u8; 16];
        let sealed = encrypt(b"correct horse battery", &key);
        assert_eq!(
            decrypt_cbc(&sealed, &key).as_deref(),
            Some(&b"correct horse battery"[..])
        );
        assert_eq!(decrypt_cbc(&sealed[1..], &key), None);
        assert_eq!(decrypt_cbc(&sealed, &[7u8; 15]), None);
        assert_eq!(decrypt_cbc(b"v10", &key), None);
    }
}
