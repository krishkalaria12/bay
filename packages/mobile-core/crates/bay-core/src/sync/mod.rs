//! Phone ↔ computer sync through Bay's relay: the chain's keys and sealed files, the recovery phrase, pairing by
//! code, and the relay transport. A port of `packages/sync/src/relay`, checked against the Mac's CryptoKit with
//! `fixtures/golden.json`.

pub mod bytes;
pub mod canon;
pub mod hlc;
pub mod http;
pub mod keys;
pub mod order;
pub mod pairing;
pub mod phone;
pub mod phrase;
pub mod scope;
pub mod transport;

#[cfg(test)]
mod scope_tests;
#[cfg(test)]
pub(crate) mod stand_in;
