//! The recovery phrase, as RecoveryPhrase.swift writes and reads it: the chain key's 32 bytes and the first byte of
//! their SHA-256 as 24 BIP-39 English words. A word may be typed by its first four letters or more.

use bip39::Language;
use sha2::{Digest, Sha256};

pub const PHRASE_WORDS: usize = 24;

/// Why a phrase didn't read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PhraseProblem {
    /// A recovery phrase has 24 words; this has `count`.
    WordCount { count: u32 },
    /// `word` isn't a recovery phrase word.
    UnknownWord { word: String },
    /// These words aren't a recovery phrase: one may be wrong or out of order.
    Checksum,
}

/// The phrase for a chain key.
pub fn phrase_words(entropy: &[u8; 32]) -> Vec<String> {
    let words = Language::English.word_list();
    let checksum = Sha256::digest(entropy)[0];
    let bits: Vec<u16> = entropy
        .iter()
        .chain(std::iter::once(&checksum))
        .flat_map(|byte| {
            (0..8)
                .rev()
                .map(move |shift| u16::from((byte >> shift) & 1))
        })
        .collect();
    bits.chunks(11)
        .map(|chunk| {
            words[chunk
                .iter()
                .fold(0usize, |index, bit| (index << 1) | usize::from(*bit))]
            .to_owned()
        })
        .collect()
}

/// A phrase's words as typed: letters only, lowercase.
fn tokens(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_ascii_lowercase())
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .collect()
}

fn index_of(token: &str) -> Option<usize> {
    let words = Language::English.word_list();
    if let Some(exact) = words.iter().position(|word| *word == token) {
        return Some(exact);
    }
    if token.len() < 4 {
        return None;
    }
    // BIP-39's English words differ in their first four letters.
    words
        .iter()
        .position(|word| word.len() >= 4 && word[..4] == token[..4] && word.starts_with(token))
}

/// The chain key a phrase holds, or why it holds none.
pub fn phrase_entropy(text: &str) -> Result<[u8; 32], PhraseProblem> {
    let tokens = tokens(text);
    if tokens.len() != PHRASE_WORDS {
        return Err(PhraseProblem::WordCount {
            count: tokens.len() as u32,
        });
    }
    let mut bits = Vec::with_capacity(PHRASE_WORDS * 11);
    for token in &tokens {
        let index = index_of(token).ok_or_else(|| PhraseProblem::UnknownWord {
            word: token.clone(),
        })?;
        bits.extend((0..11).rev().map(|shift| (index >> shift) & 1));
    }
    let byte = |bits: &[usize]| bits.iter().fold(0u8, |byte, bit| (byte << 1) | *bit as u8);
    let mut entropy = [0u8; 32];
    for (i, chunk) in bits[..256].chunks(8).enumerate() {
        entropy[i] = byte(chunk);
    }
    if Sha256::digest(entropy)[0] == byte(&bits[256..]) {
        Ok(entropy)
    } else {
        Err(PhraseProblem::Checksum)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::tests::{golden, hex};

    #[test]
    fn the_phrase_is_bip39s_and_reads_back_from_four_letter_prefixes() {
        let entropy: [u8; 32] = hex(&golden()["entropy"]).try_into().unwrap();
        let words = phrase_words(&entropy);
        assert_eq!(
            words.join(" "),
            bip39::Mnemonic::from_entropy(&entropy).unwrap().to_string()
        );
        assert_eq!(phrase_entropy(&words.join(" ")), Ok(entropy));
        let prefixes: Vec<String> = words
            .iter()
            .map(|word| word[..4.min(word.len())].to_uppercase())
            .collect();
        assert_eq!(phrase_entropy(&prefixes.join(", ")), Ok(entropy));
        assert_eq!(
            phrase_entropy(&words[1..].join(" ")),
            Err(PhraseProblem::WordCount { count: 23 })
        );
        let mut unknown = words[..23].to_vec();
        unknown.push("zzzz".into());
        assert_eq!(
            phrase_entropy(&unknown.join(" ")),
            Err(PhraseProblem::UnknownWord {
                word: "zzzz".into()
            })
        );
        let mut swapped = words[..23].to_vec();
        swapped.push(words[0].clone());
        assert_eq!(
            phrase_entropy(&swapped.join(" ")).is_err(),
            words[23] != words[0]
        );
    }
}
