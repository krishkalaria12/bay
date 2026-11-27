//! Bytes in the forms sync names and sends them: lowercase base32 (the tags and file names, as SyncCrypto.swift
//! writes them) and base64. A port of `packages/sync/src/relay/bytes.ts`.

const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Lowercase base32 without padding: SyncCrypto.swift's `Base32.encode`.
pub fn base32(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len() * 8 / 5 + 1);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for &byte in data {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            out.push(BASE32[((buffer >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
        buffer &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(BASE32[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// A tag: 16 bytes in base32, the length every chain, scope and file name has.
pub fn is_tag(name: &str) -> bool {
    name.len() == 26
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || (b'2'..=b'7').contains(&byte))
}

pub fn base64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let word = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(BASE64[((word >> 18) & 63) as usize] as char);
        out.push(BASE64[((word >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            BASE64[((word >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64[(word & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// base64url without padding.
pub fn base64url(data: &[u8]) -> String {
    base64(data)
        .replace('+', "-")
        .replace('/', "_")
        .trim_end_matches('=')
        .to_owned()
}

/// Reads base64 or base64url, with or without padding or whitespace.
pub fn from_base64(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for char in text
        .chars()
        .filter(|char| !char.is_whitespace() && *char != '=')
    {
        let char = match char {
            '-' => '+',
            '_' => '/',
            other => other,
        };
        let value = BASE64.iter().position(|&known| known as char == char)? as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
        buffer &= (1 << bits) - 1;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_is_lowercase_and_unpadded() {
        assert_eq!(base32(b"hello"), "nbswy3dp");
        assert!(is_tag(&base32(&[7; 16])));
    }

    #[test]
    fn base64_round_trips_in_both_alphabets() {
        for data in [&b""[..], b"f", b"fo", b"foo", &[0xfb, 0xff, 0xfe]] {
            assert_eq!(from_base64(&base64(data)).unwrap(), data);
            assert_eq!(from_base64(&base64url(data)).unwrap(), data);
        }
        assert_eq!(base64(&[0xfb, 0xff]), "+/8=");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
        assert_eq!(from_base64("not base64!"), None);
    }
}
