//! The phone's side of sync: the adapters that map the chain's records to the browser store, the cycle over the app's
//! scope and each linked space's, and the doc saved between launches. A port of the Expo app's `src/sync`.

pub mod adapters;
pub mod engine;

#[cfg(test)]
mod tests;
