//! The links in text exported from another browser (Arc Search shares a tab list as text).

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use url::Url;

use super::ImportedTab;
use crate::js::{JS_SPACE, slice, trim};

const TITLE_LIMIT: usize = 300;

fn pattern(source: &str) -> Regex {
    Regex::new(&source.replace("{S}", JS_SPACE)).unwrap()
}

// Anything that starts a link; the address's own characters are validated by the URL parser.
static LINK: LazyLock<Regex> = LazyLock::new(|| pattern(r#"(?i-u:https?://)[^<>"'`{S}]+"#));
static LINE_END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r?\n").unwrap());
static TRAILING_PUNCTUATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"[.,;:!?'"`]+$"#).unwrap());
static TRAILING_BRACKETS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[)\]}]+$").unwrap());
static BULLET: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[{S}]*(?:[-*•]|[0-9]+[.)])[{S}]+"));
static OPENING: LazyLock<Regex> = LazyLock::new(|| pattern(r"[\[(][{S}]*$"));
static CLOSING: LazyLock<Regex> = LazyLock::new(|| pattern(r"\][{S}]*$"));
static LEADING_BRACKETS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[+").unwrap());
static LEADING_MARKS: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[\-–—:|{S}]+"));
static TRAILING_MARKS: LazyLock<Regex> = LazyLock::new(|| pattern(r"[\-–—:|{S}]+$"));

/// Finds the links in text exported from another browser. Lines may carry a title before the link or markdown around
/// it; everything that isn't an HTTP(S) link is ignored. Links are deduplicated in the order they appear, so a page
/// named twice opens as one tab.
pub fn imported_tabs(text: &str) -> Vec<ImportedTab> {
    let mut seen = HashSet::new();
    let mut tabs = Vec::new();
    for line in LINE_END.split(text) {
        for found in LINK.find_iter(line) {
            let Some(url) = web_address(found.as_str()) else {
                continue;
            };
            if !seen.insert(url.clone()) {
                continue;
            }
            tabs.push(ImportedTab {
                url,
                title: title_before(line, found.start()),
            });
        }
    }
    tabs
}

/// The canonical address, or none when it isn't an HTTP(S) URL with a host and no credentials.
fn web_address(value: &str) -> Option<String> {
    let trimmed = TRAILING_PUNCTUATION.replace(value, "");
    let trimmed = TRAILING_BRACKETS.replace(&trimmed, "");
    let url = Url::parse(&trimmed).ok()?;
    let web = matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|host| !host.is_empty())
        && url.username().is_empty()
        && url.password().is_none_or(str::is_empty);
    web.then(|| url.into())
}

/// The text a line puts before its link, without bullets, numbering or markdown.
fn title_before(line: &str, index: usize) -> String {
    let title = &line[..index];
    let title = BULLET.replace(title, "");
    let title = OPENING.replace(&title, "");
    let title = CLOSING.replace(&title, "");
    let title = LEADING_BRACKETS.replace(&title, "");
    let title = LEADING_MARKS.replace(&title, "");
    let title = TRAILING_MARKS.replace(&title, "");
    slice(trim(&title), TITLE_LIMIT)
}
