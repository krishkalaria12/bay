//! Address input: what typed text becomes (an address or a search), how addresses show, the search engines, the
//! calculator, emoji and quick-create rows, and the suggestions under the search field. A port of `@bay/core`'s
//! `input.ts`, `appUrls.ts`, `cleanUrl.ts`, `idn.ts`, `engines.ts`, `calculator.ts`, `emoji.ts`, `quickCreate.ts` and
//! `suggest.ts`, as the phone uses them, and the Expo app's `src/browser/address.ts`; checked against what they did in
//! their tests (`tests/input_fixtures.rs`).

pub mod address;
pub mod app_urls;
pub mod bangs;
pub mod calc;
pub mod clean;
pub mod emoji;
pub mod engines;
pub mod ffi;
pub mod idn;
pub mod quick_create;
pub mod scope_suggest;
pub mod search_field;
pub mod site_search;
pub mod suggest;
pub mod url;

use std::sync::LazyLock;

/// A pattern compiled once, the first time it's used.
pub(crate) struct Pattern(LazyLock<regex::Regex>);

/// Compiles a pattern this module writes itself; a bad one is a bug caught by the first test that runs it.
pub(crate) fn pattern(source: &str) -> regex::Regex {
    regex::Regex::new(source).unwrap_or_else(|error| panic!("pattern {source}: {error}"))
}

/// A pattern that needs lookaround, which only `fancy-regex` has.
pub(crate) fn fancy(source: &str) -> fancy_regex::Regex {
    fancy_regex::Regex::new(source).unwrap_or_else(|error| panic!("pattern {source}: {error}"))
}

impl Pattern {
    pub(crate) const fn new(build: fn() -> regex::Regex) -> Self {
        Self(LazyLock::new(build))
    }
}

impl std::ops::Deref for Pattern {
    type Target = regex::Regex;

    fn deref(&self) -> &regex::Regex {
        &self.0
    }
}
