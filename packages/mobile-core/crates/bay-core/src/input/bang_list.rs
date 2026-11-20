//! The bang list kept fresh, as the desktop keeps it (`@bay/core`'s `bangs.ts` and the command bar's search service):
//! once a day the apps fetch Helium's `bangs.json` with the version they have, the core cuts it down to its
//! `triggers\tname\ttemplate` lines, checks it, saves it beside the store and puts it in use. Anything wrong with an
//! answer keeps the list in use, which starts as the one Bay ships.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;

use super::bangs::{BANG_PLACEHOLDER, BangTable, is_valid_bang_template, use_bangs};
use crate::sync::http::{HttpRequest, HttpResponse};

/// Where the list comes from.
pub const BANG_LIST_URL: &str = "https://services.helium.imput.net/bangs.json";
/// How long the list may take.
const BANG_LIST_TIMEOUT_MS: u32 = 10_000;
/// How long a fetched (or confirmed) list is kept before asking again.
const REFRESH_MS: i64 = 24 * 60 * 60 * 1000;
/// Fewer bangs than this isn't the list.
const MIN_BANGS: usize = 1000;
/// More than this isn't the list either.
pub const MAX_BANG_LIST_CHARS: usize = 4_000_000;
/// Bangs every real list has.
const REQUIRED_TRIGGERS: [&str; 3] = ["gh", "w", "yt"];
/// The saved file's first line starts with this, then a tab and the list's version.
const BANG_DOCUMENT: &str = "bay-bangs 1";
const STORED_PLACEHOLDER: &str = "{s}";
const DOCUMENT_FILE: &str = "bangs.txt";
const CHECKED_FILE: &str = "bangs-checked";

/// The index just past the string whose opening quote is before `from`.
fn end_of_string(text: &[u8], from: usize) -> usize {
    let mut at = from;
    while at < text.len() {
        match text[at] {
            b'\\' => at += 2,
            b'"' => return at + 1,
            _ => at += 1,
        }
    }
    text.len()
}

/// Past blanks and comments from `from`.
fn skip_blank(text: &[u8], from: usize) -> usize {
    let mut at = from;
    loop {
        while at < text.len() && text[at].is_ascii_whitespace() {
            at += 1;
        }
        if text[at..].starts_with(b"//") {
            at = text[at..]
                .iter()
                .position(|c| *c == b'\n')
                .map_or(text.len(), |end| at + end);
        } else if text[at..].starts_with(b"/*") {
            at = text[at + 2..]
                .windows(2)
                .position(|pair| pair == b"*/")
                .map_or(text.len(), |end| at + 2 + end + 2);
        } else {
            return at;
        }
    }
}

/// JSON as the list is written: comments and trailing commas allowed.
pub fn parse_loose_json(text: &str) -> Option<Value> {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut from, mut at) = (0, 0);
    while at < bytes.len() {
        match bytes[at] {
            b'"' => at = end_of_string(bytes, at + 1),
            b'/' if matches!(bytes.get(at + 1), Some(b'/' | b'*')) => {
                out.push_str(&text[from..at]);
                from = skip_blank(bytes, at);
                at = from;
            }
            b',' => {
                let next = skip_blank(bytes, at + 1);
                if matches!(bytes.get(next), Some(b']' | b'}')) {
                    out.push_str(&text[from..at]);
                    from = at + 1;
                }
                at += 1;
            }
            _ => at += 1,
        }
    }
    out.push_str(&text[from.min(text.len())..]);
    serde_json::from_str(&out).ok()
}

/// Helium's list cut down to `triggers\tname\ttemplate` lines: a trigger in two entries keeps the first, and an entry
/// whose address could send the words to another site is left out. None when it isn't the list.
pub fn slim_bangs(json: &str) -> Option<String> {
    let Value::Array(list) = parse_loose_json(json)? else {
        return None;
    };
    let mut seen = std::collections::HashSet::new();
    let mut lines = Vec::new();
    for entry in &list {
        let (Some(name), Some(Value::Array(triggers)), Some(url)) = (
            entry.get("s").and_then(Value::as_str),
            entry.get("ts"),
            entry.get("u").and_then(Value::as_str),
        ) else {
            continue;
        };
        if !is_valid_bang_template(url) || url.contains(STORED_PLACEHOLDER) {
            continue;
        }
        let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
        if name.is_empty() {
            continue;
        }
        let kept: Vec<String> = triggers
            .iter()
            .filter_map(Value::as_str)
            .map(|trigger| trigger.trim().to_lowercase())
            .filter(|trigger| {
                !trigger.is_empty()
                    && !trigger.chars().any(|c| c.is_whitespace() || c == '!')
                    && seen.insert(trigger.clone())
            })
            .collect();
        if kept.is_empty() {
            continue;
        }
        let stored = match url.get(..8) {
            Some(start) if start.eq_ignore_ascii_case("https://") => &url[8..],
            _ => url,
        }
        .replace(BANG_PLACEHOLDER, STORED_PLACEHOLDER);
        lines.push(format!("{}\t{name}\t{stored}", kept.join(" ")));
    }
    (lines.len() >= MIN_BANGS).then(|| lines.join("\n"))
}

/// A list once every line reads and the common bangs are in it; none otherwise.
pub fn checked_bang_table(slim: String) -> Option<BangTable> {
    if slim.len() > MAX_BANG_LIST_CHARS {
        return None;
    }
    let mut count = 0;
    for line in slim.split('\n') {
        let mut fields = line.split('\t');
        let (Some(triggers), Some(name), Some(stored), None) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            return None;
        };
        let triggers_read = !triggers.is_empty()
            && triggers
                .split(' ')
                .all(|t| !t.is_empty() && !t.chars().any(|c| c.is_whitespace() || c == '!'));
        let full = if stored.len() >= 7
            && (stored[..7].eq_ignore_ascii_case("http://")
                || stored
                    .get(..8)
                    .is_some_and(|s| s.eq_ignore_ascii_case("https://")))
        {
            stored.to_owned()
        } else {
            format!("https://{stored}")
        };
        if !triggers_read
            || name.is_empty()
            || !is_valid_bang_template(&full.replace(STORED_PLACEHOLDER, BANG_PLACEHOLDER))
        {
            return None;
        }
        count += 1;
    }
    if count < MIN_BANGS {
        return None;
    }
    let table = BangTable::new(slim);
    REQUIRED_TRIGGERS
        .iter()
        .all(|trigger| table.get(trigger).is_some())
        .then_some(table)
}

/// The saved file: a first line naming it and the list's version, then the list.
pub fn bang_document(etag: Option<&str>, slim: &str) -> String {
    format!("{BANG_DOCUMENT}\t{}\n{slim}", etag.unwrap_or_default())
}

/// A saved file read back: its version and its list, once checked.
pub fn read_bang_document(doc: &str) -> Option<(Option<String>, BangTable)> {
    if doc.len() > MAX_BANG_LIST_CHARS + 1024 {
        return None;
    }
    let (head, slim) = doc.split_once('\n')?;
    let mut fields = head.split('\t');
    let (Some(BANG_DOCUMENT), etag, None) = (
        fields.next(),
        fields.next().unwrap_or_default(),
        fields.next(),
    ) else {
        return None;
    };
    let table = checked_bang_table(slim.to_owned())?;
    Some(((!etag.is_empty()).then(|| etag.to_owned()), table))
}

/// The bang list on this phone: the saved one (or Bay's own) in use, and when to ask for a newer one.
#[derive(uniffi::Object)]
pub struct BangList {
    dir: PathBuf,
    /// Puts a checked list in use: `use_bangs`, the list searches read.
    install: fn(BangTable),
    /// The version in use, sent so an unchanged list answers 304, and when it was last fetched or confirmed.
    state: Mutex<(Option<String>, i64)>,
}

impl BangList {
    fn with_install(documents_dir: String, install: fn(BangTable)) -> std::sync::Arc<Self> {
        let dir = PathBuf::from(documents_dir);
        let mut etag = None;
        if let Some((saved, table)) = fs::read_to_string(dir.join(DOCUMENT_FILE))
            .ok()
            .and_then(|doc| read_bang_document(&doc))
        {
            etag = saved;
            install(table);
        }
        let checked = fs::read_to_string(dir.join(CHECKED_FILE))
            .ok()
            .and_then(|text| text.trim().parse().ok())
            .unwrap_or(0);
        std::sync::Arc::new(Self {
            dir,
            install,
            state: Mutex::new((etag, checked)),
        })
    }
}

#[uniffi::export]
impl BangList {
    /// Reads the list saved in `documents_dir` and puts it in use, if it's still sound.
    #[uniffi::constructor]
    pub fn open(documents_dir: String) -> std::sync::Arc<Self> {
        Self::with_install(documents_dir, use_bangs)
    }

    /// The request to send for a newer list, once a day; none until then.
    pub fn request(&self, now: i64) -> Option<HttpRequest> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Never fetched, a day on, or a clock that went back: ask.
        if state.1 > 0 && now >= state.1 && now - state.1 < REFRESH_MS {
            return None;
        }
        let mut request = HttpRequest::new("GET", BANG_LIST_URL);
        request.timeout_ms = Some(BANG_LIST_TIMEOUT_MS);
        if let Some(etag) = &state.0 {
            request.headers.insert("If-None-Match".into(), etag.clone());
        }
        Some(request)
    }

    /// What the server answered. A new list that checks out is saved and put in use; an unchanged one (304) waits
    /// another day; anything else is asked for again next time. True when a new list is in use.
    pub fn answer(&self, response: HttpResponse, now: i64) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match response.status {
            304 => {
                state.1 = now;
                let _ = fs::write(self.dir.join(CHECKED_FILE), now.to_string());
                false
            }
            200 => {
                let Some(slim) = String::from_utf8(response.body)
                    .ok()
                    .filter(|text| text.len() <= MAX_BANG_LIST_CHARS * 2)
                    .and_then(|text| slim_bangs(&text))
                else {
                    return false;
                };
                let etag = response.headers.get("etag").cloned();
                let doc = bang_document(etag.as_deref(), &slim);
                let Some(table) = checked_bang_table(slim) else {
                    return false;
                };
                // Saved first, so the list in use is always one the next start reads back.
                if fs::write(self.dir.join(DOCUMENT_FILE), doc).is_err() {
                    return false;
                }
                let _ = fs::write(self.dir.join(CHECKED_FILE), now.to_string());
                *state = (etag, now);
                (self.install)(table);
                true
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, triggers: &str, url: &str) -> String {
        format!(r#"{{"s": "{name}", "ts": [{triggers}], "u": "{url}"}}"#)
    }

    fn list(extra: &str) -> String {
        let mut entries: Vec<String> = (0..1100)
            .map(|n| {
                entry(
                    &format!("Site {n}"),
                    &format!("\"s{n}\""),
                    &format!("https://site{n}.example/?q={BANG_PLACEHOLDER}"),
                )
            })
            .collect();
        entries.push(entry(
            "GitHub",
            r#""gh", "GIT""#,
            "https://github.com/search?q={searchTerms}",
        ));
        entries.push(entry(
            "Wikipedia",
            r#""w""#,
            "https://en.wikipedia.org/w/index.php?search={searchTerms}",
        ));
        entries.push(entry(
            "YouTube",
            r#""yt", "gh""#,
            "https://www.youtube.com/results?search_query={searchTerms}",
        ));
        format!(
            "// Generated\n[\n{},\n{extra}\n/* the end */\n]\n",
            entries.join(",\n")
        )
    }

    #[test]
    fn the_list_reads_with_comments_and_a_trailing_comma() {
        assert_eq!(
            parse_loose_json("// a\n[1, /* b */ 2, \"//c\",]"),
            Some(serde_json::json!([1, 2, "//c"]))
        );
        assert_eq!(
            parse_loose_json("{\"a\": \"x\\\"//\",}"),
            Some(serde_json::json!({"a": "x\"//"}))
        );
    }

    #[test]
    fn a_list_is_cut_down_checked_and_kept_its_first_trigger() {
        let slim = slim_bangs(&list(
            r#"{"s": "Bad", "ts": ["bad"], "u": "https://{searchTerms}.example/"},"#,
        ))
        .unwrap();
        assert!(slim.contains("gh git\tGitHub\tgithub.com/search?q={s}"));
        // "gh" stays GitHub's; the template that moves the words into the host is left out.
        assert!(slim.contains("yt\tYouTube\t"));
        assert!(!slim.contains("\tBad\t"));
        let table = checked_bang_table(slim.clone()).unwrap();
        assert_eq!(table.get("gh").unwrap().name, "GitHub");
        let doc = bang_document(Some("\"v1\""), &slim);
        let (etag, read) = read_bang_document(&doc).unwrap();
        assert_eq!(etag.as_deref(), Some("\"v1\""));
        assert_eq!(read.len(), table.len());
        // Too short, or missing the common ones, isn't the list.
        assert!(slim_bangs("[]").is_none());
        assert!(checked_bang_table(slim.replace("\nw\t", "\nwx\t")).is_none());
        assert!(read_bang_document(&doc.replacen("bay-bangs 1", "bay-bangs 2", 1)).is_none());
    }

    #[test]
    fn the_list_is_asked_for_once_a_day_and_saved() {
        let dir = std::env::temp_dir().join(format!("bay-bangs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // The list it fetches stays out of the one other tests search with.
        let bangs = BangList::with_install(dir.to_string_lossy().into(), |_| {});
        let request = bangs.request(1_000).unwrap();
        assert_eq!(request.url, BANG_LIST_URL);
        assert!(!request.headers.contains_key("If-None-Match"));
        // A broken answer changes nothing and is asked for again.
        assert!(!bangs.answer(HttpResponse::new(200, b"oops".to_vec()), 1_000));
        assert!(bangs.request(2_000).is_some());
        let mut ok = HttpResponse::new(200, list("").into_bytes());
        ok.headers.insert("etag".into(), "\"v2\"".into());
        assert!(bangs.answer(ok, 3_000));
        assert!(bangs.request(3_000 + REFRESH_MS - 1).is_none());
        let again = BangList::with_install(dir.to_string_lossy().into(), |_| {});
        let next = again.request(3_000 + REFRESH_MS).unwrap();
        assert_eq!(
            next.headers.get("If-None-Match").map(String::as_str),
            Some("\"v2\"")
        );
        assert!(!again.answer(HttpResponse::new(304, Vec::new()), 3_000 + REFRESH_MS));
        assert!(again.request(3_000 + REFRESH_MS + 1).is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
