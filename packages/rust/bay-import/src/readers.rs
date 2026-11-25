//! The readers that need no secret: exported files (passwords CSV, bookmarks HTML), Chromium and Firefox bookmarks,
//! history, and Chromium's extension list. Ported from `packages/import/portable/Readers.cpp`, answer for answer.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::failure::{Failure, Result};
use crate::snapshot::{Snapshot, integer, is_null, text};

/// A flag the host sets to stop an import; readers check it as they go.
#[derive(Clone, Copy)]
pub struct Cancel<'a>(pub &'a AtomicBool);

impl Cancel<'_> {
    pub fn check(&self) -> Result<()> {
        if self.0.load(Ordering::Relaxed) {
            Err(Failure::new("cancelled", "Import cancelled"))
        } else {
            Ok(())
        }
    }
}

/// How much history to read, and whether to hand it over in chunks as it's read.
#[derive(Clone, Debug)]
pub struct HistoryOptions {
    /// At most this many entries; negative for all.
    pub limit: i64,
    /// Only visits from this time on (milliseconds since 1970).
    pub since: f64,
    pub chunk_size: i64,
    /// Give entries to the observer in chunks instead of returning them.
    pub stream: bool,
}

impl Default for HistoryOptions {
    fn default() -> Self {
        Self {
            limit: -1,
            since: 0.0,
            chunk_size: 1000,
            stream: false,
        }
    }
}

const MAX_FILE: u64 = 256 * 1024 * 1024;

pub(crate) fn read_bytes(path: &Path) -> Result<Vec<u8>> {
    let size = std::fs::metadata(path)
        .map_err(|_| Failure::new("notFound", "Source file is unavailable"))?
        .len();
    if size > MAX_FILE {
        return Err(Failure::new("unreadable", "Source file is too large"));
    }
    std::fs::read(path).map_err(|_| Failure::new("unreadable", "Could not read source file"))
}

pub(crate) fn read_text(path: &Path) -> Result<String> {
    Ok(String::from_utf8_lossy(&read_bytes(path)?).into_owned())
}

fn read_json(path: &Path) -> Result<Value> {
    serde_json::from_str(&read_text(path)?)
        .map_err(|_| Failure::new("unreadable", "Source file isn't valid JSON"))
}

/// Chromium's time (microseconds since 1601) in whole milliseconds since 1970; the app rejects fractional times.
pub fn chromium_time(micros: i64) -> f64 {
    if micros > 0 {
        ((micros - 11_644_473_600_000_000) as f64 / 1000.0).floor()
    } else {
        0.0
    }
}

fn trim(text: &str) -> &str {
    text.trim_matches([' ', '\r', '\n', '\t'])
}

/// The number at the start of `text`, as `strtoll` reads it (leading spaces, a sign, then digits).
fn leading_integer(text: &str) -> Option<i64> {
    let text = text.trim_start();
    let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
    let length = digits.bytes().take_while(u8::is_ascii_digit).count();
    if length == 0 {
        return None;
    }
    text[..text.len() - digits.len() + length].parse().ok()
}

/// The number at the start of `text`, as `strtod` reads it.
fn leading_float(text: &str) -> Option<f64> {
    let text = text.trim_start();
    (1..=text.len())
        .rev()
        .filter(|end| text.is_char_boundary(*end))
        .find_map(|end| {
            let prefix = &text[..end];
            // Rust also reads "inf" and "nan", which strtod's callers here never wrote.
            prefix
                .bytes()
                .any(|byte| byte.is_ascii_digit())
                .then(|| prefix.parse::<f64>().ok())
                .flatten()
        })
}

fn folder(title: &str) -> Map<String, Value> {
    let mut node = Map::new();
    node.insert("type".into(), json!("folder"));
    node.insert("title".into(), json!(title));
    node.insert("children".into(), json!([]));
    node
}

fn children(node: &mut Map<String, Value>) -> &mut Vec<Value> {
    node.entry("children")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .expect("a folder's children are a list")
}

fn string_field(node: &Value, key: &str) -> String {
    node.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

// MARK: Exported files

pub fn parse_passwords_csv(input: &str) -> Result<Value> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let end_row = |row: &mut Vec<String>, field: &mut String, rows: &mut Vec<Vec<String>>| {
        row.push(std::mem::take(field));
        if !(row.len() == 1 && row[0].is_empty()) {
            rows.push(std::mem::take(row));
        }
        row.clear();
    };
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
        } else if c == '"' && field.is_empty() {
            quoted = true;
        } else if c == ',' {
            row.push(std::mem::take(&mut field));
        } else if c == '\r' || c == '\n' {
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            end_row(&mut row, &mut field, &mut rows);
        } else {
            field.push(c);
        }
    }
    if !field.is_empty() || !row.is_empty() {
        end_row(&mut row, &mut field, &mut rows);
    }
    let Some(header) = rows.first().cloned() else {
        return Err(Failure::new("unreadable", "The file is empty"));
    };
    let header: Vec<String> = header
        .iter()
        .map(|name| trim(name).to_ascii_lowercase())
        .collect();
    let find = |names: &[&str]| {
        names
            .iter()
            .find_map(|name| header.iter().position(|column| column == name))
    };
    let url = find(&[
        "url",
        "login_uri",
        "website",
        "web site",
        "origin",
        "hostname",
        "login url",
    ]);
    let pass = find(&["password", "login_password", "pass"]);
    let user = find(&[
        "username",
        "login_username",
        "login",
        "user",
        "email",
        "user name",
    ]);
    let (Some(url), Some(pass)) = (url, pass) else {
        return Err(Failure::new(
            "unsupported",
            "This CSV does not have URL and password columns",
        ));
    };
    let optional = [
        ("title", find(&["name", "title"])),
        ("note", find(&["note", "notes", "extra"])),
        ("realm", find(&["httprealm"])),
        ("otpAuth", find(&["otpauth"])),
    ];
    let numbers = [
        ("created", find(&["timecreated"])),
        ("lastUsed", find(&["timelastused"])),
    ];
    let mut result = Vec::new();
    for row in &rows[1..] {
        let get = |column: Option<usize>| {
            column
                .and_then(|column| row.get(column))
                .cloned()
                .unwrap_or_default()
        };
        if get(Some(url)).is_empty() || get(Some(pass)).is_empty() {
            continue;
        }
        let mut credential = Map::new();
        credential.insert("url".into(), json!(get(Some(url))));
        credential.insert("username".into(), json!(get(user)));
        credential.insert("password".into(), json!(get(Some(pass))));
        for (key, column) in optional {
            let value = get(column);
            if !value.is_empty() {
                credential.insert(key.into(), json!(value));
            }
        }
        for (key, column) in numbers {
            if let Some(number) = leading_float(&get(column)) {
                credential.insert(key.into(), json!(number));
            }
        }
        result.push(Value::Object(credential));
    }
    Ok(Value::Array(result))
}

/// Decodes the HTML entities bookmark exports use; an unknown one stays as written.
fn entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let decoded = after.find(';').filter(|semi| *semi < 12).and_then(|semi| {
            let name = &after[..semi];
            let value = match name {
                "amp" => Some("&".to_owned()),
                "lt" => Some("<".to_owned()),
                "gt" => Some(">".to_owned()),
                "quot" => Some("\"".to_owned()),
                "apos" => Some("'".to_owned()),
                "nbsp" => Some("\u{a0}".to_owned()),
                _ => name.strip_prefix('#').and_then(|number| {
                    let (digits, radix) = match number.strip_prefix(['x', 'X']) {
                        Some(hex) => (hex, 16),
                        None => (number, 10),
                    };
                    let length = digits.chars().take_while(|c| c.is_digit(radix)).count();
                    u32::from_str_radix(&digits[..length], radix)
                        .ok()
                        .and_then(char::from_u32)
                        .map(String::from)
                }),
            };
            value.map(|value| (value, semi))
        });
        match decoded {
            Some((value, semi)) => {
                out.push_str(&value);
                rest = &after[semi + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

static TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<\s*(/?)\s*([a-zA-Z0-9]+)((?:[^>"']|"[^"]*"|'[^']*')*)>"#).expect("valid pattern")
});
static ATTRIBUTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"([a-zA-Z_][a-zA-Z_0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#)
        .expect("valid pattern")
});
static COMMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<!--[\s\S]*?-->").expect("valid pattern"));

/// A Netscape bookmark file (every browser's HTML export) as a bookmark tree.
pub fn parse_netscape_bookmarks(html: &str) -> Value {
    let mut stack = vec![folder("Bookmarks")];
    let mut pending: Option<Map<String, Value>> = None;
    let mut saw_root = false;
    fn flush(stack: &mut [Map<String, Value>], pending: &mut Option<Map<String, Value>>) {
        if let Some(node) = pending.take() {
            children(stack.last_mut().expect("the root stays")).push(Value::Object(node));
        }
    }
    let clean = COMMENT.replace_all(html, "").into_owned();
    for found in TAG.captures_iter(&clean) {
        let whole = found.get(0).expect("a match");
        let name = found[2].to_ascii_lowercase();
        let close = !found[1].is_empty();
        if name == "dl" {
            if close {
                flush(&mut stack, &mut pending);
                if stack.len() > 1 {
                    let child = stack.pop().expect("more than one");
                    children(stack.last_mut().expect("the root stays")).push(Value::Object(child));
                }
            } else if let Some(node) = pending.take() {
                stack.push(node);
            } else if !saw_root {
                saw_root = true;
            } else {
                stack.push(folder(""));
            }
        }
        if close || (name != "a" && name != "h3") {
            continue;
        }
        let mut attributes: BTreeMap<String, String> = BTreeMap::new();
        for attribute in ATTRIBUTE.captures_iter(&found[3]) {
            let value = attribute
                .get(2)
                .or_else(|| attribute.get(3))
                .or_else(|| attribute.get(4))
                .map_or("", |m| m.as_str());
            attributes.insert(attribute[1].to_ascii_lowercase(), entities(value));
        }
        let attribute = |key: &str| attributes.get(key).cloned().unwrap_or_default();
        let tail = &clean[whole.end()..];
        let mut title_text = String::new();
        let mut consumed = 0;
        let tokens: Vec<_> = TAG.captures_iter(tail).collect();
        for (index, token) in tokens.iter().enumerate() {
            let span = token.get(0).expect("a match");
            title_text.push_str(&tail[consumed..span.start()]);
            consumed = span.end();
            let tag = token[2].to_ascii_lowercase();
            let closing = !token[1].is_empty();
            if (closing && tag == name)
                || (!closing && matches!(tag.as_str(), "a" | "h3" | "dl" | "dt"))
            {
                break;
            }
            if index + 1 == tokens.len() {
                title_text.push_str(&tail[consumed..]);
            }
        }
        if consumed == 0 {
            title_text = tail.to_owned();
        }
        let title = trim(&entities(&title_text)).to_owned();
        let mut node;
        if name == "h3" {
            flush(&mut stack, &mut pending);
            node = folder(&title);
            if attribute("personal_toolbar_folder").eq_ignore_ascii_case("true")
                || attribute("id") == "com.apple.FavoritesBar"
            {
                node.insert("role".into(), json!("toolbar"));
            } else if attribute("unfiled_bookmarks_folder").eq_ignore_ascii_case("true") {
                node.insert("role".into(), json!("other"));
            } else if attribute("id") == "com.apple.ReadingList" {
                node.insert("role".into(), json!("readingList"));
            }
        } else {
            let href = attribute("href");
            if href.is_empty() {
                continue;
            }
            flush(&mut stack, &mut pending);
            node = Map::new();
            node.insert("type".into(), json!("url"));
            node.insert(
                "title".into(),
                json!(if title.is_empty() {
                    href.clone()
                } else {
                    title
                }),
            );
            node.insert("url".into(), json!(href));
        }
        if let Some(date) = leading_float(&attribute("add_date")).filter(|date| *date > 0.0) {
            node.insert("dateAdded".into(), json!(date * 1000.0));
        }
        if name == "h3" {
            pending = Some(node);
        } else {
            children(stack.last_mut().expect("the root stays")).push(Value::Object(node));
        }
    }
    flush(&mut stack, &mut pending);
    while stack.len() > 1 {
        let child = stack.pop().expect("more than one");
        children(stack.last_mut().expect("the root stays")).push(Value::Object(child));
    }
    Value::Object(stack.pop().expect("the root"))
}

// MARK: Chromium

fn chromium_bookmark(node: &Value, depth: usize) -> Option<Map<String, Value>> {
    if depth > 64 || !node.is_object() {
        return None;
    }
    let mut out = match node.get("type").and_then(Value::as_str) {
        Some("url") => {
            if string_field(node, "url").is_empty() {
                return None;
            }
            let mut out = Map::new();
            out.insert("type".into(), json!("url"));
            out.insert("title".into(), json!(string_field(node, "name")));
            out.insert("url".into(), node["url"].clone());
            out
        }
        Some("folder") => {
            let mut out = folder(&string_field(node, "name"));
            for child in node
                .get("children")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(child) = chromium_bookmark(child, depth + 1) {
                    children(&mut out).push(Value::Object(child));
                }
            }
            out
        }
        _ => return None,
    };
    let added = node
        .get("date_added")
        .and_then(Value::as_str)
        .unwrap_or("0");
    if let Some(micros) = leading_integer(added) {
        let time = chromium_time(micros);
        if time != 0.0 {
            out.insert("dateAdded".into(), json!(time));
        }
    }
    Some(out)
}

/// A Chromium profile's bookmarks (`Bookmarks` and the signed-in account's `AccountBookmarks`), by root.
pub fn chromium_bookmarks(profile: &Path) -> Result<Value> {
    let mut out = folder("Bookmarks");
    let mut found = false;
    for file in ["Bookmarks", "AccountBookmarks"] {
        let path = profile.join(file);
        if !path.exists() {
            continue;
        }
        found = true;
        let data = read_json(&path)?;
        let Some(roots) = data.get("roots") else {
            return Err(Failure::new("unreadable", "Invalid Chromium bookmarks"));
        };
        for (root, role) in [
            ("bookmark_bar", "toolbar"),
            ("other", "other"),
            ("synced", "mobile"),
        ] {
            let Some(root) = roots.get(root) else {
                continue;
            };
            let Some(mut node) = chromium_bookmark(root, 0) else {
                continue;
            };
            if children(&mut node).is_empty() {
                continue;
            }
            node.insert("role".into(), json!(role));
            let list = children(&mut out);
            match list
                .iter_mut()
                .find(|existing| existing.get("role").and_then(Value::as_str) == Some(role))
            {
                Some(existing) => {
                    let more = std::mem::take(children(&mut node));
                    existing["children"]
                        .as_array_mut()
                        .expect("a folder")
                        .extend(more);
                }
                None => list.push(Value::Object(node)),
            }
        }
    }
    if !found {
        return Err(Failure::new("notFound", "No bookmarks in this profile"));
    }
    Ok(Value::Object(out))
}

/// The extensions a Chromium profile installed from the Chrome Web Store and has on.
pub fn extensions(profile: &Path) -> Result<Value> {
    let mut output = Vec::new();
    let mut seen = HashSet::new();
    for name in ["Preferences", "Secure Preferences"] {
        let path = profile.join(name);
        if !path.exists() {
            continue;
        }
        let data = read_json(&path)?;
        let Some(settings) = data
            .get("extensions")
            .and_then(|e| e.get("settings"))
            .and_then(Value::as_object)
        else {
            continue;
        };
        for (id, entry) in settings {
            if id.len() != 32
                || !id.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
                || seen.contains(id)
            {
                continue;
            }
            let manifest_name = entry
                .get("manifest")
                .and_then(|m| m.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if entry.get("state").and_then(Value::as_i64) != Some(1)
                || entry.get("from_webstore").and_then(Value::as_bool) != Some(true)
                || manifest_name.is_empty()
            {
                continue;
            }
            seen.insert(id.clone());
            output.push(json!({
                "id": id,
                "name": manifest_name,
                "webStoreUrl": format!("https://chromewebstore.google.com/detail/{id}"),
            }));
        }
    }
    Ok(Value::Array(output))
}

// MARK: Firefox

/// A Firefox profile's bookmarks (`places.sqlite`), by root.
pub fn firefox_bookmarks(profile: &Path, cancel: Cancel<'_>) -> Result<Value> {
    struct Row {
        id: i64,
        kind: i64,
        title: String,
        url: String,
        date_added: f64,
        guid: String,
    }
    let db = Snapshot::open(&profile.join("places.sqlite"))?;
    let mut by_parent: BTreeMap<i64, Vec<Row>> = BTreeMap::new();
    let mut root = 0;
    db.query(
        "SELECT b.id,b.type,b.parent,b.title,p.url,b.dateAdded,b.guid FROM moz_bookmarks b LEFT JOIN moz_places p \
         ON b.fk=p.id ORDER BY b.parent,b.position",
        |row| {
            cancel.check()?;
            let entry = Row {
                id: integer(row, 0),
                kind: integer(row, 1),
                title: text(row, 3),
                url: text(row, 4),
                date_added: integer(row, 5) as f64 / 1000.0,
                guid: text(row, 6),
            };
            if entry.guid == "root________" {
                root = entry.id;
            } else {
                by_parent.entry(integer(row, 2)).or_default().push(entry);
            }
            Ok(true)
        },
    )?;
    if root == 0 {
        return Err(Failure::new(
            "unreadable",
            "Firefox bookmark root is missing",
        ));
    }
    fn build(
        id: i64,
        depth: usize,
        by_parent: &BTreeMap<i64, Vec<Row>>,
        cancel: Cancel<'_>,
    ) -> Result<Vec<Value>> {
        let mut out = Vec::new();
        if depth >= 64 {
            return Ok(out);
        }
        for row in by_parent.get(&id).map(Vec::as_slice).unwrap_or_default() {
            cancel.check()?;
            let mut node = match row.kind {
                1 => {
                    if row.url.is_empty() || row.url.starts_with("place:") {
                        continue;
                    }
                    let mut node = Map::new();
                    node.insert("type".into(), json!("url"));
                    node.insert("title".into(), json!(row.title));
                    node.insert("url".into(), json!(row.url));
                    node
                }
                2 => {
                    let mut node = folder(&row.title);
                    node.insert(
                        "children".into(),
                        Value::Array(build(row.id, depth + 1, by_parent, cancel)?),
                    );
                    node
                }
                _ => continue,
            };
            node.insert("dateAdded".into(), json!(row.date_added));
            out.push(Value::Object(node));
        }
        Ok(out)
    }
    let mut out = folder("Bookmarks");
    for (guid, role, title) in [
        ("toolbar_____", "toolbar", "Bookmarks Toolbar"),
        ("menu________", "menu", "Bookmarks Menu"),
        ("unfiled_____", "other", "Other Bookmarks"),
        ("mobile______", "mobile", "Mobile Bookmarks"),
    ] {
        for row in by_parent.get(&root).map(Vec::as_slice).unwrap_or_default() {
            if row.guid != guid {
                continue;
            }
            let mut node = folder(title);
            let built = build(row.id, 0, &by_parent, cancel)?;
            if built.is_empty() {
                continue;
            }
            node.insert("children".into(), Value::Array(built));
            node.insert("role".into(), json!(role));
            node.insert("dateAdded".into(), json!(row.date_added));
            children(&mut out).push(Value::Object(node));
        }
    }
    Ok(Value::Object(out))
}

// MARK: History

/// A profile's history (Chromium's `History` or Firefox's `places.sqlite`), newest first. `observer` hears progress,
/// and the entries themselves in chunks when `options.stream`.
pub fn history(
    profile: &Path,
    firefox: bool,
    options: &HistoryOptions,
    observer: &mut dyn FnMut(Value),
    cancel: Cancel<'_>,
) -> Result<(Value, i64)> {
    let db = Snapshot::open(&profile.join(if firefox { "places.sqlite" } else { "History" }))?;
    let mut all = Vec::new();
    let mut chunk = Vec::new();
    let mut count: i64 = 0;
    if options.limit == 0 {
        return Ok((Value::Array(all), 0));
    }
    observer(json!({"type": "progress", "kind": "history", "phase": "start", "processed": 0}));
    let sql = if firefox {
        "SELECT url,title,visit_count,last_visit_date,typed FROM moz_places WHERE hidden=0 AND visit_count>0 AND \
         last_visit_date IS NOT NULL AND (url LIKE 'http://%' OR url LIKE 'https://%') ORDER BY last_visit_date DESC"
    } else {
        "SELECT url,title,visit_count,last_visit_time,typed_count FROM urls WHERE hidden=0 AND last_visit_time>0 AND \
         (url LIKE 'http://%' OR url LIKE 'https://%') ORDER BY last_visit_time DESC"
    };
    let chunk_size = options.chunk_size.max(1);
    db.query(sql, |row| {
        cancel.check()?;
        let time = if firefox { integer(row, 3) as f64 / 1000.0 } else { chromium_time(integer(row, 3)) };
        if time < options.since {
            return Ok(true);
        }
        let mut entry = Map::new();
        entry.insert("url".into(), json!(text(row, 0)));
        entry.insert("title".into(), json!(text(row, 1)));
        entry.insert("visits".into(), json!((integer(row, 2) as i32).max(1)));
        entry.insert("lastVisit".into(), json!(time));
        if !is_null(row, 4) {
            entry.insert("typedCount".into(), json!(integer(row, 4) as i32));
        }
        count += 1;
        if options.stream {
            chunk.push(Value::Object(entry));
        } else {
            all.push(Value::Object(entry));
        }
        if count % chunk_size == 0 {
            if options.stream {
                observer(json!({"type": "history", "entries": Value::Array(std::mem::take(&mut chunk)).to_string()}));
            }
            observer(json!({"type": "progress", "kind": "history", "phase": "progress", "processed": count}));
        }
        Ok(options.limit < 0 || count < options.limit)
    })?;
    if !chunk.is_empty() {
        observer(json!({"type": "history", "entries": Value::Array(chunk).to_string()}));
    }
    observer(
        json!({"type": "progress", "kind": "history", "phase": "end", "processed": count, "total": count}),
    );
    Ok((Value::Array(all), count))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_read_as_the_c_library_reads_them() {
        assert_eq!(
            leading_integer(" 13234567890123456x"),
            Some(13_234_567_890_123_456)
        );
        assert_eq!(leading_integer("abc"), None);
        assert_eq!(leading_float("1700000000.5 extra"), Some(1_700_000_000.5));
        assert_eq!(leading_float(""), None);
        assert_eq!(chromium_time(13_000_000_000_000_000), 1_355_526_400_000.0);
        assert_eq!(chromium_time(0), 0.0);
    }

    #[test]
    fn entities_decode_and_unknown_ones_stay() {
        assert_eq!(
            entities("Tool &lt;beta&gt; &#10003; &#x2713; &amp; &bogus; &"),
            "Tool <beta> ✓ ✓ & &bogus; &"
        );
    }

    #[test]
    fn quoted_csv_fields_keep_commas_newlines_and_quotes() {
        let rows = parse_passwords_csv(
            "url,username,password\r\nhttps://example.test,\"a,b\",\"line 1\nline 2 \"\"quoted\"\"\"\r\n",
        )
        .unwrap();
        assert_eq!(rows[0]["username"], "a,b");
        assert_eq!(rows[0]["password"], "line 1\nline 2 \"quoted\"");
        assert_eq!(
            parse_passwords_csv("name,notes\nx,y\n").unwrap_err().code,
            "unsupported"
        );
        assert_eq!(parse_passwords_csv("").unwrap_err().code, "unreadable");
    }

    #[test]
    fn inline_markup_in_a_bookmark_title_is_dropped_not_truncating_it() {
        let tree = parse_netscape_bookmarks(
            "<DL><DT><A HREF='https://example.test'>one <b>two</b> &amp; three</A></DL>",
        );
        assert_eq!(tree["children"][0]["title"], "one two & three");
    }
}
