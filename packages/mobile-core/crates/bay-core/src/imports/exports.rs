//! What other browsers' export files hold, read on the device: a bookmarks HTML file (the Netscape format every
//! browser writes), Safari's export (a folder of Bookmarks.html and History.json) and Chrome's Takeout (Bookmarks.html
//! and History.json). Passwords, cards and anything else secret are never read here: the native side leaves those
//! files in the archive and only names them.

use std::collections::HashMap;
use std::sync::LazyLock;

use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use serde_json::Value;
use url::Url;

use super::{
    BookmarkRole, ExportContents, ExportFile, ImportError, ImportedBookmark, ImportedVisit,
};
use crate::js::{JS_SPACE, math_round, slice, string_to_number, trim};

/// How many sites the start page takes from an import.
pub const FAVORITES_LIMIT: usize = 12;

fn pattern(source: &str) -> Regex {
    Regex::new(&source.replace("{S}", JS_SPACE)).unwrap()
}

/// The address, canonical, or none when it isn't an HTTP(S) page with a host and no credentials.
pub fn web_address(value: &str) -> Option<String> {
    let url = Url::parse(trim(value)).ok()?;
    let web = matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|host| !host.is_empty())
        && url.username().is_empty()
        && url.password().is_none_or(str::is_empty);
    web.then(|| url.into())
}

/// Every link under a node, in order.
pub fn bookmark_links(node: &ImportedBookmark) -> Vec<ImportedBookmark> {
    if node.url.as_deref().is_some_and(|url| !url.is_empty()) {
        return vec![node.clone()];
    }
    node.children().iter().flat_map(bookmark_links).collect()
}

/// How many links a node holds.
pub fn link_count(node: &ImportedBookmark) -> usize {
    if node.url.as_deref().is_some_and(|url| !url.is_empty()) {
        return 1;
    }
    node.children().iter().map(link_count).sum()
}

static ENTITY: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);"));

/// Undoes the HTML escaping exports use in titles and addresses.
pub fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_owned();
    }
    ENTITY
        .replace_all(text, |captures: &regex::Captures| {
            let whole = &captures[0];
            let name = &captures[1];
            if let Some(number) = name.strip_prefix('#') {
                let code = match number.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex.trim_start_matches('0'), 16).ok(),
                    None => number.trim_start_matches('0').parse().ok(),
                }
                .or_else(|| {
                    number
                        .trim_start_matches(['#', 'x', 'X', '0'])
                        .is_empty()
                        .then_some(0)
                });
                return match code.filter(|code| (1..=0x10ffff).contains(code)) {
                    // A lone surrogate can't live in a Rust string: it reads as the replacement character.
                    Some(code) => char::from_u32(code).unwrap_or('\u{fffd}').to_string(),
                    None => whole.to_owned(),
                };
            }
            match name.to_lowercase().as_str() {
                "amp" => "&",
                "lt" => "<",
                "gt" => ">",
                "quot" => "\"",
                "apos" => "'",
                "nbsp" => "\u{a0}",
                _ => whole,
            }
            .to_owned()
        })
        .into_owned()
}

static ATTRIBUTE: LazyLock<Regex> =
    LazyLock::new(|| pattern(r#"([a-zA-Z_:-]+)[{S}]*=[{S}]*(?:"([^"]*)"|'([^']*)'|([^>{S}]+))"#));

/// A tag's attributes, lowercased by name.
fn attributes(source: &str) -> HashMap<String, String> {
    ATTRIBUTE
        .captures_iter(source)
        .map(|captures| {
            let value = captures
                .get(2)
                .or(captures.get(3))
                .or(captures.get(4))
                .map_or("", |value| value.as_str());
            (captures[1].to_lowercase(), value.to_owned())
        })
        .collect()
}

/// An ADD_DATE (seconds since the epoch) in milliseconds.
fn added_at(value: Option<&String>) -> Option<i64> {
    let seconds = string_to_number(value?);
    // Rounding can make a tiny time 0, which the export then has none of.
    (seconds.is_finite() && seconds > 0.0)
        .then(|| math_round(seconds * 1000.0) as i64)
        .filter(|ms| *ms != 0)
}

fn folder_role(attrs: &HashMap<String, String>) -> Option<BookmarkRole> {
    let flag = |name: &str| {
        attrs
            .get(name)
            .is_some_and(|value| value.to_lowercase() == "true")
    };
    match attrs.get("id").map(String::as_str) {
        Some("com.apple.FavoritesBar") => Some(BookmarkRole::Favorites),
        Some("com.apple.ReadingList") => Some(BookmarkRole::ReadingList),
        _ if flag("personal_toolbar_folder") => Some(BookmarkRole::Toolbar),
        _ if flag("unfiled_bookmarks_folder") => Some(BookmarkRole::Other),
        _ => None,
    }
}

static MARKUP: LazyLock<Regex> = LazyLock::new(|| pattern(r"<[^>]*>"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| pattern(r"[{S}]+"));

/// Text between the end of one tag and the next tag, without markup.
fn plain_text(html: &str) -> String {
    let text = decode_entities(&MARKUP.replace_all(html, ""));
    trim(&SPACES.replace_all(&text, " ")).to_owned()
}

static DOCTYPE: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"<!(?i-u:DOCTYPE)[{S}]+(?i-u:NETSCAPE-Bookmark-file)"));

/// Whether text is a bookmarks file: the Netscape format's doctype, which every browser writes.
#[uniffi::export]
pub fn is_bookmarks_html(text: &str) -> bool {
    DOCTYPE.is_match(&slice(text, 2048))
}

static TAG: LazyLock<Regex> = LazyLock::new(|| pattern(r"<(/?)((?i-u:dl|h3|a))(?-u:\b)([^>]*)>"));
static H3_END: LazyLock<Regex> = LazyLock::new(|| pattern(r"<(?i-u:/h3)[{S}]*>"));
static A_END: LazyLock<Regex> = LazyLock::new(|| pattern(r"<(?i-u:/a)[{S}]*>"));

/// Reads a Netscape bookmarks file. A folder is an <H3> followed by a <DL> of its entries, a bookmark an <A HREF>;
/// anything that isn't a web page (javascript:, place:, file:) is left out, and so is a folder left empty by that.
#[uniffi::export]
pub fn parse_bookmarks_html(html: &str) -> ImportedBookmark {
    // The folders still open, the file's own root first. A folder joins its parent when it closes.
    let mut stack = vec![ImportedBookmark::folder(String::new())];
    // A folder's heading comes before its list: it waits here until the list opens.
    let mut pending: Option<ImportedBookmark> = None;
    // For each list still open, whether it opened a folder (and so closes one).
    let mut lists: Vec<bool> = Vec::new();

    fn place(stack: &mut [ImportedBookmark], node: ImportedBookmark) {
        if let Some(children) = stack.last_mut().and_then(|top| top.children.as_mut()) {
            children.push(node);
        }
    }
    fn close(stack: &mut Vec<ImportedBookmark>) {
        if let Some(folder) = stack.pop() {
            place(stack, folder);
        }
    }

    let mut at = 0;
    while let Some(tag) = TAG.captures_at(html, at) {
        let whole = tag.get(0).unwrap();
        at = whole.end();
        let closing = &tag[1] == "/";
        let name = tag[2].to_lowercase();

        if name == "dl" {
            if closing {
                if let Some(folder) = pending.take() {
                    place(&mut stack, folder);
                }
                if lists.pop().unwrap_or(false) && stack.len() > 1 {
                    close(&mut stack);
                }
            } else if let Some(folder) = pending.take() {
                // The heading's list: the folder's entries go in it until the list closes.
                stack.push(folder);
                lists.push(true);
            } else {
                // The file's own list, or one with no heading: its entries stay in the folder around it.
                lists.push(false);
            }
            continue;
        }

        if closing {
            continue;
        }
        let attrs = attributes(&tag[3]);
        let closer = if name == "h3" { &*H3_END } else { &*A_END };
        let end = closer.find_at(html, at).map(|found| found.start());
        // A tag left open ends its text at the next tag.
        let stop = end
            .or_else(|| html[at..].find('<').map(|next| at + next))
            .unwrap_or(html.len());
        let title = plain_text(&html[at..stop]);
        if let Some(end) = end {
            at = end;
        }

        // A heading that never opened a list is an empty folder; the prune below drops it.
        if let Some(folder) = pending.take() {
            place(&mut stack, folder);
        }

        let date = added_at(attrs.get("add_date"));

        if name == "h3" {
            pending = Some(ImportedBookmark {
                added_at: date,
                role: folder_role(&attrs),
                ..ImportedBookmark::folder(title)
            });
            continue;
        }

        let Some(url) = web_address(&decode_entities(
            attrs.get("href").map_or("", String::as_str),
        )) else {
            continue;
        };
        place(
            &mut stack,
            ImportedBookmark {
                title: if title.is_empty() { url.clone() } else { title },
                url: Some(url),
                added_at: date,
                children: None,
                role: None,
            },
        );
    }

    if let Some(folder) = pending.take() {
        place(&mut stack, folder);
    }
    // Lists the file never closed close here, each folder into the one around it.
    while stack.len() > 1 {
        close(&mut stack);
    }

    prune(
        stack
            .pop()
            .unwrap_or_else(|| ImportedBookmark::folder(String::new())),
    )
}

/// Drops the folders that hold no bookmarks, however deep.
fn prune(node: ImportedBookmark) -> ImportedBookmark {
    if node.url.as_deref().is_some_and(|url| !url.is_empty()) {
        return node;
    }
    let children = node
        .children
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(prune)
        .filter(|child| {
            child.url.as_deref().is_some_and(|url| !url.is_empty()) || !child.children().is_empty()
        })
        .collect();
    ImportedBookmark {
        children: Some(children),
        ..node
    }
}

/// A row of a history file as Bay reads it, or none when Bay can't.
struct Row {
    url: String,
    title: String,
    time_usec: f64,
    visits: f64,
}

/// A time in microseconds since the epoch, as a number or the string Takeout sometimes writes.
fn micros(value: Option<&Value>) -> Option<f64> {
    match value {
        None => Some(0.0),
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(text)) => Some(string_to_number(text)),
        Some(_) => None,
    }
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    match value {
        None => Some(String::new()),
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => None,
    }
}

/// A row of Safari's History.json: one page, with how often it was visited. A redirect Safari followed (a row with a
/// `destination_url`) reads as nothing: the page it led to has its own row.
fn safari_row(row: &Value) -> Option<Option<Row>> {
    let row = row.as_object()?;
    let url = row.get("url")?.as_str()?.to_owned();
    let title = optional_string(row.get("title"))?;
    let time_usec = micros(row.get("time_usec"))?;
    let visit_count = match row.get("visit_count") {
        None => 1.0,
        Some(value) => value.as_f64()?,
    };
    match row.get("destination_url") {
        None => {}
        Some(Value::String(_)) => return Some(None),
        Some(_) => return None,
    }
    Some(Some(Row {
        url,
        title,
        time_usec,
        visits: if visit_count > 0.0 {
            visit_count.floor()
        } else {
            1.0
        },
    }))
}

/// A row of Takeout's History.json: one visit.
fn takeout_row(row: &Value) -> Option<Row> {
    let row = row.as_object()?;
    Some(Row {
        url: row.get("url")?.as_str()?.to_owned(),
        title: optional_string(row.get("title"))?,
        time_usec: micros(row.get("time_usec"))?,
        visits: 1.0,
    })
}

/// Microseconds in milliseconds; 0 when the value isn't a time.
fn from_micros(value: f64) -> i64 {
    if value.is_finite() && value > 0.0 {
        (value / 1000.0).floor() as i64
    } else {
        0
    }
}

/// Adds visits to the pages already counted, keeping the newest title.
fn count_visits(pages: &mut IndexMap<String, ImportedVisit>, visit: ImportedVisit) {
    let Some(previous) = pages.get_mut(&visit.url) else {
        pages.insert(visit.url.clone(), visit);
        return;
    };
    let newer = visit.last_visit > previous.last_visit;
    let title = if newer {
        if visit.title.is_empty() {
            previous.title.clone()
        } else {
            visit.title
        }
    } else if previous.title.is_empty() {
        visit.title
    } else {
        previous.title.clone()
    };
    *previous = ImportedVisit {
        url: visit.url,
        title,
        visits: previous.visits.saturating_add(visit.visits),
        last_visit: previous.last_visit.max(visit.last_visit),
    };
}

/// Newest first; pages visited at the same moment keep their order.
fn newest_first(pages: IndexMap<String, ImportedVisit>) -> Vec<ImportedVisit> {
    let mut pages: Vec<ImportedVisit> = pages.into_values().collect();
    pages.sort_by_key(|page| std::cmp::Reverse(page.last_visit));
    pages
}

/// Reads a history export: Safari's History.json (`history`, one row per page with its visit count) or Takeout's
/// History.json (`Browser History`, one row per visit). None when the text is neither. A row Bay can't read is
/// skipped, so one odd row doesn't lose the file.
#[uniffi::export]
pub fn parse_history_json(text: &str) -> Option<Vec<ImportedVisit>> {
    let json: Value = serde_json::from_str(text).ok()?;
    let file = json.as_object()?;
    let rows: Vec<Option<Row>> = if let Some(Value::Array(rows)) = file.get("history") {
        rows.iter().map(|row| safari_row(row).flatten()).collect()
    } else if let Some(Value::Array(rows)) = file.get("Browser History") {
        rows.iter().map(takeout_row).collect()
    } else {
        return None;
    };

    let mut pages = IndexMap::new();
    for row in rows.into_iter().flatten() {
        let last_visit = from_micros(row.time_usec);
        let Some(url) = web_address(&row.url) else {
            continue;
        };
        if last_visit != 0 {
            count_visits(
                &mut pages,
                ImportedVisit {
                    url,
                    title: trim(&row.title).to_owned(),
                    visits: row.visits as i64,
                    last_visit,
                },
            );
        }
    }
    Some(newest_first(pages))
}

/// The sites a browser shows first: the links at the top of its favorites (or bookmarks bar) folder.
fn favorites_of(bookmarks: &ImportedBookmark) -> Vec<ImportedBookmark> {
    let folders = bookmarks.children();
    let folder = folders
        .iter()
        .find(|child| child.role == Some(BookmarkRole::Favorites))
        .or_else(|| {
            folders
                .iter()
                .find(|child| child.role == Some(BookmarkRole::Toolbar))
        });
    let mut seen = IndexSet::new();
    folder
        .map(ImportedBookmark::children)
        .unwrap_or_default()
        .iter()
        .filter(|child| {
            child
                .url
                .as_deref()
                .is_some_and(|url| !url.is_empty() && seen.insert(url.to_owned()))
        })
        .take(FAVORITES_LIMIT)
        .cloned()
        .collect()
}

static JSON_START: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[{S}]*\{"));

/// Reads every file an export held. Bookmark files merge into one tree, history files into one list; files in no
/// format Bay knows are skipped. An error when not one file could be read.
pub fn read_export(files: &[ExportFile]) -> Result<ExportContents, ImportError> {
    let mut bookmarks = ImportedBookmark::folder(String::new());
    let mut history = IndexMap::new();
    let mut recognised = false;

    for file in files {
        if is_bookmarks_html(&file.text) {
            recognised = true;
            if let Some(children) = bookmarks.children.as_mut() {
                children.extend(
                    parse_bookmarks_html(&file.text)
                        .children
                        .unwrap_or_default(),
                );
            }
            continue;
        }
        let visits = if JSON_START.is_match(&file.text) {
            parse_history_json(&file.text)
        } else {
            None
        };
        let Some(visits) = visits else {
            continue;
        };
        recognised = true;
        for visit in visits {
            count_visits(&mut history, visit);
        }
    }

    if !recognised {
        return Err(ImportError::UnknownExport);
    }
    Ok(ExportContents {
        favorites: favorites_of(&bookmarks),
        bookmarks,
        history: newest_first(history),
    })
}
