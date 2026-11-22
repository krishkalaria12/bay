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

/// How the page menu writes a page's address, as Arc Search does: on a search engine's results page the words that
/// were searched, else just the site. `custom_url` is the custom engine's address, when that's the one chosen.
#[uniffi::export]
pub fn address_label(url: &str, custom_url: Option<String>) -> String {
    let templates = built_in_engines()
        .into_iter()
        .map(|engine| engine.url)
        .chain(custom_url);
    templates
        .filter_map(|template| searched_words(url, &template))
        .next()
        .unwrap_or_else(|| site_name(url))
}

/// The words a results page was searched for, when `url` is one of `template`'s (same host and path, the query in the
/// parameter that takes `%s`).
fn searched_words(url: &str, template: &str) -> Option<String> {
    let page = url::Url::parse(url).ok()?;
    let engine = url::Url::parse(template).ok()?;
    let bare = |host: Option<&str>| host.map(|host| host.trim_start_matches("www.").to_owned());
    if bare(page.host_str()) != bare(engine.host_str()) || page.path() != engine.path() {
        return None;
    }
    let (param, _) = engine.query_pairs().find(|(_, value)| value == "%s")?;
    let (_, words) = page.query_pairs().find(|(name, _)| *name == param)?;
    let words = js::trim(&words).to_owned();
    (!words.is_empty()).then_some(words)
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
    #[test]
    fn address_label_shows_the_words_searched_or_the_site() {
        use super::address_label;
        assert_eq!(
            address_label("https://www.google.com/search?q=cats&sca_esv=1", None),
            "cats"
        );
        assert_eq!(
            address_label("https://duckduckgo.com/?q=red+pandas&ia=web", None),
            "red pandas"
        );
        assert_eq!(
            address_label("https://www.theverge.com/2026/11/22/pixel-review", None),
            "theverge.com"
        );
        assert_eq!(
            address_label("https://www.google.com/maps", None),
            "google.com"
        );
        assert_eq!(
            address_label(
                "https://search.example/find?term=tea",
                Some("https://search.example/find?term=%s".into())
            ),
            "tea"
        );
    }

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
