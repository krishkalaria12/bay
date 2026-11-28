//! What the store tests share: a browser on a test clock, and the address rules the tests rely on.

#![allow(dead_code)]

use std::cell::Cell;

use bay_state::Browser;
use bay_state::store::{Clock, Settings};

/// The app's own address rules (@bay/core's `resolveInput`, shared with the phones).
pub fn resolve(raw: &str, settings: &Settings) -> String {
    bay_state::store::resolve_typed(raw, settings)
}

/// A browser with one space, no windows and a clock that moves only when a test moves it.
pub fn browser() -> Browser {
    Browser::with_clock(resolve, Clock::Manual(Cell::new(1_764_000_000_000.0)))
}

pub fn ids(list: &[&String]) -> Vec<String> {
    list.iter().map(|id| (*id).clone()).collect()
}
