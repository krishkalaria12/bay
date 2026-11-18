//! What the phone's search field opens: an address, or a search with the chosen engine. A port of the Expo app's
//! `src/browser/address.ts`.

use super::engines::{SearchEngine, built_in_engines, engine_by_id, search_url};
use super::url::{fixup_url, host_of};
use crate::js;

/// The id the custom engine is chosen by.
pub const CUSTOM_ENGINE_ID: &str = "custom";

/// The chosen search engine. The custom one is the address the user gave, named by its site; it asks for no
/// suggestions. Without an address it falls back to the default.
pub fn engine_for(id: &str, custom_url: Option<&str>) -> SearchEngine {
    if let Some(url) = custom_url.filter(|url| id == CUSTOM_ENGINE_ID && !url.is_empty()) {
        let host = host_of(&url.replace("%s", "q"));
        let host = if host.is_empty() {
            url.to_owned()
        } else {
            host
        };
        return SearchEngine {
            id: CUSTOM_ENGINE_ID.into(),
            name: host.clone(),
            keyword: host,
            url: url.into(),
            suggest_url: None,
            custom: true,
        };
    }
    engine_by_id(&built_in_engines(), Some(id))
}

/// HTTP(S) with a host and no credentials: the only pages the engines open.
#[uniffi::export]
pub fn is_web_url(value: &str) -> bool {
    url::Url::parse(value).ok().is_some_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some_and(|host| !host.is_empty())
            && url.username().is_empty()
            && url.password().is_none()
    })
}

/// What typed text opens: a website address, or otherwise a search with the chosen engine. A leading "?" searches.
pub fn resolve_address(input: &str, engine: &SearchEngine) -> Option<String> {
    let text = js::trim(input);
    if text.is_empty() {
        return None;
    }
    if let Some(rest) = text.strip_prefix('?') {
        return (!rest.is_empty()).then(|| search_url(&engine.url, rest));
    }
    match fixup_url(text).filter(|url| is_web_url(url)) {
        Some(url) => url::Url::parse(&url).ok().map(|url| url.to_string()),
        None => Some(search_url(&engine.url, text)),
    }
}

/// The host without "www.", for titles of pages that haven't loaded one.
#[uniffi::export]
pub fn site_name(url: &str) -> String {
    let host = host_of(url);
    if host.is_empty() {
        url.to_owned()
    } else {
        host
    }
}

/// A page's title for a list row: its own, or its site's name when it has none or the title is only an address.
#[uniffi::export]
pub fn page_title(title: &str, url: &str) -> String {
    let is_address = title.split_once("://").is_some_and(|(scheme, _)| {
        scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    });
    if title.is_empty() || is_address {
        site_name(url)
    } else {
        title.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::page_title;

    #[test]
    fn a_row_falls_back_to_the_site_when_the_title_is_missing_or_an_address() {
        let url = "https://www.example.com/a";
        assert_eq!(page_title("Docs", url), "Docs");
        assert_eq!(page_title("", url), "example.com");
        assert_eq!(page_title("https://www.example.com/a", url), "example.com");
        assert_eq!(page_title("Read: a://b", url), "Read: a://b");
    }
}
