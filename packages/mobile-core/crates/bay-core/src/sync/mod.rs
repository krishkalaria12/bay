//! Phone ↔ computer sync through Bay's relay: the chain's keys and sealed files, the recovery phrase, pairing by
//! code, and the relay transport. A port of `packages/sync/src/relay`, checked against the Mac's CryptoKit with
//! `fixtures/golden.json`.

pub mod bytes;
pub mod http;
pub mod keys;
pub mod pairing;
pub mod phrase;
pub mod transport;

#[cfg(test)]
pub(crate) mod stand_in;
