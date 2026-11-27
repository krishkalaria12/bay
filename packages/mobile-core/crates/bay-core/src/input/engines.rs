//! Search engines: the built-in list, search and suggestion addresses, and reading an engine's suggestions.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::url::{host_of, search_url_for};
use crate::js;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct SearchEngine {
    pub id: String,
    pub name: String,
    pub keyword: String,
    /// The search address, with `%s` where the words go.
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggest_url: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub custom: bool,
}

const BUILT_IN: &[(&str, &str, &str, &str, Option<&str>)] = &[
    (
        "google",
        "Google",
        "google.com",
        "https://www.google.com/search?q=%s",
        Some(
            "https://suggestqueries.google.com/complete/search?client=firefox&ie=utf-8&oe=utf-8&q=%s",
        ),
    ),
    (
        "bing",
        "Bing",
        "bing.com",
        "https://www.bing.com/search?q=%s",
        Some("https://api.bing.com/osjson.aspx?query=%s"),
    ),
    (
        "duckduckgo",
        "DuckDuckGo",
        "duckduckgo.com",
        "https://duckduckgo.com/?q=%s",
        Some("https://duckduckgo.com/ac/?q=%s&type=list"),
    ),
    (
        "perplexity",
        "Perplexity",
        "perplexity.ai",
        "https://www.perplexity.ai/search?q=%s",
        None,
    ),
    (
        "chatgpt",
        "ChatGPT",
        "chatgpt.com",
        "https://chatgpt.com/?q=%s",
        None,
    ),
    (
        "ecosia",
        "Ecosia",
        "ecosia.org",
        "https://www.ecosia.org/search?q=%s",
        Some("https://ac.ecosia.org/autocomplete?q=%s&type=list"),
    ),
    (
        "brave",
        "Brave Search",
        "search.brave.com",
        "https://search.brave.com/search?q=%s",
        Some("https://search.brave.com/api/suggest?q=%s"),
    ),
    (
        "kagi",
        "Kagi",
        "kagi.com",
        "https://kagi.com/search?q=%s",
        None,
    ),
    (
        "startpage",
        "Startpage",
        "startpage.com",
        "https://www.startpage.com/do/search?q=%s",
        Some("https://www.startpage.com/osuggestions?q=%s"),
    ),
    (
        "yahoo",
        "Yahoo",
        "yahoo.com",
        "https://search.yahoo.com/search?p=%s",
        Some("https://search.yahoo.com/sugg/ff?output=fxjson&command=%s"),
    ),
    (
        "baidu",
        "Baidu",
        "baidu.com",
        "https://www.baidu.com/s?wd=%s",
        Some("https://www.baidu.com/su?action=opensearch&ie=utf-8&wd=%s"),
    ),
    (
        "yandex",
        "Yandex",
        "yandex.com",
        "https://yandex.com/search/?text=%s",
        Some("https://suggest.yandex.com/suggest-ff.cgi?part=%s"),
    ),
];

/// The built-in engines, in Settings' order; Google first, the default.
#[uniffi::export]
pub fn built_in_engines() -> Vec<SearchEngine> {
    BUILT_IN
        .iter()
        .map(|(id, name, keyword, url, suggest)| SearchEngine {
            id: (*id).into(),
            name: (*name).into(),
            keyword: (*keyword).into(),
            url: (*url).into(),
            suggest_url: suggest.map(str::to_owned),
            custom: false,
        })
        .collect()
}

pub fn engine_by_id(engines: &[SearchEngine], id: Option<&str>) -> SearchEngine {
    engines
        .iter()
        .find(|engine| Some(engine.id.as_str()) == id)
        .cloned()
        .unwrap_or_else(|| built_in_engines().remove(0))
}

pub fn search_url(engine_url: &str, query: &str) -> String {
    search_url_for(engine_url, query)
}

/// Where to ask an engine for suggestions, when it has a place and there are words to ask about.
pub fn suggest_request_url(engine: &SearchEngine, query: &str) -> Option<String> {
    engine
        .suggest_url
        .as_ref()
        .filter(|_| !js::trim(query).is_empty())
        .map(|url| search_url_for(url, query))
}

pub fn engine_host(engine_url: &str) -> String {
    host_of(&engine_url.replace("%s", "q"))
}

/// An engine's suggestions answer, as the bytes it sent: the suggestions, or none when it isn't one.
#[uniffi::export]
pub fn parse_suggestions_body(body: String) -> Vec<String> {
    serde_json::from_str(&body)
        .map(|body: Value| parse_suggestions(&body))
        .unwrap_or_default()
}

/// An OpenSearch suggestions answer (`[query, [suggestions…]]`) as the suggestions, trimmed, without empty ones.
pub fn parse_suggestions(body: &Value) -> Vec<String> {
    body.as_array()
        .and_then(|body| body.get(1))
        .and_then(Value::as_array)
        .map(|suggestions| {
            suggestions
                .iter()
                .filter_map(Value::as_str)
                .map(js::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
