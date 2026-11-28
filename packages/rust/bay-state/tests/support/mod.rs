//! What the store tests share: a browser on a test clock, and the address rules the tests rely on.

#![allow(dead_code)]

use std::cell::Cell;

use bay_state::Browser;
use bay_state::store::{Clock, Settings};

/// @bay/core's `resolveInput` for the addresses the tests type: a host gets https://, anything else is a search.
pub fn resolve(raw: &str, _: &Settings) -> String {
    let input = raw.trim();
    if input.is_empty() || input.contains("://") {
        input.to_owned()
    } else if input.contains('.') && !input.contains(char::is_whitespace) {
        format!("https://{input}")
    } else {
        format!(
            "https://www.google.com/search?q={}",
            input.replace(' ', "%20")
        )
    }
}

/// A browser with one space, no windows and a clock that moves only when a test moves it.
pub fn browser() -> Browser {
    Browser::with_clock(resolve, Clock::Manual(Cell::new(1_764_000_000_000.0)))
}

pub fn ids(list: &[&String]) -> Vec<String> {
    list.iter().map(|id| (*id).clone()).collect()
}
