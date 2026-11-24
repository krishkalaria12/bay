//! Bay's encrypted sync format, one copy for every desktop: a chain's keys from its 32 random bytes, the chain and
//! scope tags that name its folders, sealed files, and the 24-word recovery phrase.
//!
//! macOS (`SyncCrypto.swift`, `RecoveryPhrase.swift`) and Windows and Linux (`packages/sync/portable/SyncCrypto.cpp`)
//! each kept their own copy, held together by one golden vector (`packages/sync/fixtures/golden.json`). The hosts keep
//! what differs: where the key is stored, the sync folder and how files reach it (iCloud Drive's coordination on
//! macOS), and drawing the recovery kit.

mod bytes;
pub mod ffi;
mod keys;
mod phrase;

pub use bytes::{base32, base64, base64url, from_base64, is_tag};
pub use keys::{NONCE, SealError, SyncKeys, random_bytes};
pub use phrase::{PHRASE_WORDS, PhraseProblem, phrase_entropy, phrase_words};
