//! The input functions the apps call, with owned arguments as UniFFI takes them.

use super::address;
use super::engines::{self, SearchEngine};

/// The chosen search engine: a built-in one by id, or the custom address when the id is "custom".
#[uniffi::export]
pub fn search_engine(id: String, custom_url: Option<String>) -> SearchEngine {
    address::engine_for(&id, custom_url.as_deref())
}

/// What typed text opens: a website address, or otherwise a search with `engine`.
#[uniffi::export]
pub fn address_for(input: String, engine: SearchEngine) -> Option<String> {
    address::resolve_address(&input, &engine)
}

/// Where to ask `engine` for suggestions for `query`, if it offers them.
#[uniffi::export]
pub fn suggestions_request_url(engine: SearchEngine, query: String) -> Option<String> {
    engines::suggest_request_url(&engine, &query)
}
