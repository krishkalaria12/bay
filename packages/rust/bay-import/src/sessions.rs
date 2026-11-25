//! Open tabs: Chromium's session files (SNSS commands), Firefox's session store (mozLz4), and Zen's spaces. Ported
//! from `packages/import/portable/Sessions.cpp`, answer for answer.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::{Map, Value, json};

use crate::failure::{Failure, Result};
use crate::readers::{Cancel, chromium_time, read_bytes};

/// Little-endian fields of a session record.
struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn truncated() -> Failure {
        Failure::new("unreadable", "Truncated session record")
    }

    fn integer(&mut self, size: usize) -> Result<u64> {
        if size > 8 || self.offset > self.bytes.len() || size > self.bytes.len() - self.offset {
            return Err(Self::truncated());
        }
        let mut out = 0u64;
        for i in 0..size {
            out |= u64::from(self.bytes[self.offset]) << (i * 8);
            self.offset += 1;
        }
        Ok(out)
    }

    fn skip(&mut self, size: usize) -> Result<()> {
        if self.offset > self.bytes.len() || size > self.bytes.len() - self.offset {
            return Err(Self::truncated());
        }
        self.offset += size;
        Ok(())
    }

    fn i32(&mut self) -> Result<i32> {
        Ok(self.integer(4)? as u32 as i32)
    }

    fn align(&mut self) -> Result<()> {
        let pad = (4 - self.offset % 4) % 4;
        self.skip(pad.min(self.bytes.len() - self.offset))
    }

    fn string(&mut self, wide: bool) -> Result<String> {
        let count = self.i32()?;
        if count < 0 {
            return Err(Failure::new("unreadable", "Invalid session string"));
        }
        let size = count as usize * if wide { 2 } else { 1 };
        if size > self.bytes.len() - self.offset {
            return Err(Failure::new("unreadable", "Truncated session string"));
        }
        let out = if wide {
            let mut out = String::new();
            let mut i = 0;
            while i < count {
                let mut point = self.integer(2)? as u32;
                if (0xd800..=0xdbff).contains(&point) && i + 1 < count {
                    let low = self.integer(2)? as u32;
                    i += 1;
                    point = if (0xdc00..=0xdfff).contains(&low) {
                        0x10000 + ((point - 0xd800) << 10) + (low - 0xdc00)
                    } else {
                        0xfffd
                    };
                } else if (0xd800..=0xdfff).contains(&point) {
                    point = 0xfffd;
                }
                out.push(char::from_u32(point).unwrap_or('\u{fffd}'));
                i += 1;
            }
            out
        } else {
            let out =
                String::from_utf8_lossy(&self.bytes[self.offset..self.offset + size]).into_owned();
            self.offset += size;
            out
        };
        self.align()?;
        Ok(out)
    }
}

fn group_id(high: u64, low: u64) -> String {
    format!("{high:016X}{low:016X}")
}

/// Firefox's mozLz4 file: the magic `mozLz40\0`, the decompressed size, then one LZ4 block.
pub(crate) fn decompress_moz_lz4(input: &[u8]) -> Result<Vec<u8>> {
    if input.len() < 12 || !input.starts_with(b"mozLz40\0") {
        return Err(Failure::new("unreadable", "Not a Firefox session"));
    }
    let size = u32::from_le_bytes(input[8..12].try_into().expect("four bytes")) as usize;
    if size > 64 * 1024 * 1024 {
        return Err(Failure::new("unreadable", "Firefox session is too large"));
    }
    let invalid = |what: &str| Failure::new("unreadable", format!("Invalid LZ4 {what}"));
    let mut reader = Reader {
        bytes: input,
        offset: 12,
    };
    let mut out: Vec<u8> = Vec::with_capacity(size);
    let extended = |reader: &mut Reader<'_>, mut length: usize| -> Result<usize> {
        if length == 15 {
            loop {
                let next = reader.integer(1).map_err(|_| invalid("block"))? as usize;
                length += next;
                if length > size {
                    return Err(invalid("block"));
                }
                if next != 255 {
                    break;
                }
            }
        }
        Ok(length)
    };
    while reader.offset < input.len() {
        let token = reader.integer(1)? as usize;
        let literals = extended(&mut reader, token >> 4)?;
        if literals > input.len() - reader.offset || literals > size - out.len() {
            return Err(invalid("literals"));
        }
        out.extend_from_slice(&input[reader.offset..reader.offset + literals]);
        reader.offset += literals;
        if reader.offset == input.len() {
            break;
        }
        let distance = reader.integer(2)? as usize;
        if distance == 0 || distance > out.len() {
            return Err(invalid("offset"));
        }
        let count = extended(&mut reader, token & 15)? + 4;
        if count > size - out.len() {
            return Err(invalid("match"));
        }
        for _ in 0..count {
            out.push(out[out.len() - distance]);
        }
    }
    if out.len() != size {
        return Err(Failure::new("unreadable", "Firefox session size mismatch"));
    }
    Ok(out)
}

fn parse_json(bytes: &[u8]) -> Result<Value> {
    serde_json::from_slice(bytes)
        .map_err(|_| Failure::new("unreadable", "The saved session isn't valid JSON"))
}

fn leading_integer(text: &str) -> Option<i64> {
    let digits = text.bytes().take_while(u8::is_ascii_digit).count();
    text[..digits].parse().ok()
}

#[derive(Default)]
struct Tab {
    window: i32,
    index: i32,
    current: i32,
    pinned: bool,
    navigations: BTreeMap<i32, (String, String)>,
    group: String,
    last_active: f64,
}

struct Window {
    kind: i32,
    selected: i32,
}

impl Default for Window {
    fn default() -> Self {
        Self {
            kind: -1,
            selected: 0,
        }
    }
}

const GROUP_COLORS: [&str; 9] = [
    "grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange",
];

/// Applies one session command. A failure means a truncated record, common while the browser is running.
fn apply(
    command: u64,
    payload: &[u8],
    tabs: &mut BTreeMap<i32, Tab>,
    windows: &mut BTreeMap<i32, Window>,
    groups: &mut BTreeMap<String, Value>,
) -> Result<()> {
    let mut r = Reader::new(payload);
    match command {
        0 => {
            let (window, tab) = (r.i32()?, r.i32()?);
            tabs.entry(tab).or_default().window = window;
        }
        2 => {
            let tab = r.i32()?;
            let index = r.i32()?;
            tabs.entry(tab).or_default().index = index;
        }
        6 => {
            r.skip(4)?;
            let (tab, index) = (r.i32()?, r.i32()?);
            let url = r.string(false)?;
            let title = r.string(true)?;
            tabs.entry(tab)
                .or_default()
                .navigations
                .insert(index, (url, title));
        }
        7 => {
            let tab = r.i32()?;
            let current = r.i32()?;
            tabs.entry(tab).or_default().current = current;
        }
        8 => {
            let window = r.i32()?;
            let selected = r.i32()?;
            windows.entry(window).or_default().selected = selected;
        }
        9 => {
            let window = r.i32()?;
            let kind = r.i32()?;
            windows.entry(window).or_default().kind = kind;
        }
        12 => {
            let tab = r.i32()?;
            let pinned = r.integer(1)? != 0;
            tabs.entry(tab).or_default().pinned = pinned;
        }
        16 => {
            tabs.remove(&r.i32()?);
        }
        17 => {
            windows.remove(&r.i32()?);
        }
        21 => {
            let tab = r.i32()?;
            r.skip(4)?;
            let time = chromium_time(r.integer(8)? as i64);
            tabs.entry(tab).or_default().last_active = time;
        }
        25 => {
            let tab = r.i32()?;
            r.skip(4)?;
            let (high, low) = (r.integer(8)?, r.integer(8)?);
            let group = if r.integer(1)? != 0 {
                group_id(high, low)
            } else {
                String::new()
            };
            tabs.entry(tab).or_default().group = group;
        }
        27 => {
            r.skip(4)?;
            let (high, low) = (r.integer(8)?, r.integer(8)?);
            let id = group_id(high, low);
            let title = r.string(true)?;
            let color = r.integer(4)? as usize;
            let collapsed = r.offset + 4 <= payload.len() && r.i32()? != 0;
            groups.insert(
                id.clone(),
                json!({"id": id, "title": title, "color": GROUP_COLORS[if color < 9 { color } else { 0 }], "collapsed": collapsed}),
            );
        }
        5 => {
            let (tab, index) = (r.i32()?, r.i32()?);
            let tab = tabs.entry(tab).or_default();
            tab.navigations.retain(|at, _| *at < index);
        }
        11 | 24 => {
            let tab = r.i32()?;
            let index = if command == 24 { r.i32()? } else { 0 };
            let count = r.i32()?;
            if index < 0 || count <= 0 {
                return Ok(());
            }
            let tab = tabs.entry(tab).or_default();
            let end = i64::from(index) + i64::from(count);
            let mut remaining = BTreeMap::new();
            for (at, navigation) in std::mem::take(&mut tab.navigations) {
                if at < index {
                    remaining.insert(at, navigation);
                } else if i64::from(at) >= end {
                    remaining.insert(at - count, navigation);
                }
            }
            tab.navigations = remaining;
            if tab.current >= index && i64::from(tab.current) < end {
                tab.current = index - 1;
            } else if i64::from(tab.current) >= end {
                tab.current -= count;
            }
        }
        _ => {}
    }
    Ok(())
}

/// A Chromium profile's newest session file: the newest `Session_<time>` in `Sessions` (or `Sessions_Encrypted`),
/// else a legacy `Current Session` or `Last Session`.
pub(crate) fn chromium_session_file(profile: &Path) -> Option<PathBuf> {
    let mut latest: Option<PathBuf> = None;
    let mut stamp: i64 = -1;
    for directory in ["Sessions", "Sessions_Encrypted"] {
        let Ok(entries) = std::fs::read_dir(profile.join(directory)) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(time) = name.strip_prefix("Session_").and_then(leading_integer) else {
                continue;
            };
            if time > stamp {
                stamp = time;
                latest = Some(entry.path());
            }
        }
    }
    latest.or_else(|| {
        ["Current Session", "Last Session"]
            .iter()
            .map(|name| profile.join(name))
            .find(|path| path.is_file())
    })
}

/// The tabs a Chromium profile last had open, from its newest session file. An encrypted one (version 5, each record
/// sealed as a `v10` value) needs the browser's `key`; without one it's `locked` when the host can unlock the browser
/// (`can_unlock`), else `unsupported`.
pub fn chromium_tabs(
    profile: &Path,
    cancel: Cancel<'_>,
    key: Option<&[u8]>,
    can_unlock: bool,
) -> Result<Value> {
    let latest = chromium_session_file(profile);
    let latest = latest.ok_or_else(|| Failure::new("notFound", "No saved tabs in this profile"))?;
    let bytes = read_bytes(&latest)?;
    let mut reader = Reader::new(&bytes);
    if reader.integer(4)? != 0x5353_4e53 {
        return Err(Failure::new("unreadable", "Not a Chromium session"));
    }
    let version = reader.integer(4)?;
    let unsupported = || {
        Failure::new(
            "unsupported",
            "The saved session is encrypted or uses a newer format. Export bookmarks for these tabs",
        )
    };
    let mut tabs: BTreeMap<i32, Tab> = BTreeMap::new();
    let mut windows: BTreeMap<i32, Window> = BTreeMap::new();
    let mut groups: BTreeMap<String, Value> = BTreeMap::new();
    match (version, key) {
        (1 | 3, _) => {
            while reader.offset + 2 <= bytes.len() {
                cancel.check()?;
                let size = reader.integer(2)? as usize;
                if size < 1 || size > bytes.len() - reader.offset {
                    break;
                }
                let command = reader.integer(1)?;
                let payload = &bytes[reader.offset..reader.offset + size - 1];
                reader.skip(size - 1)?;
                let _ = apply(command, payload, &mut tabs, &mut windows, &mut groups);
            }
        }
        (5, Some(key)) => {
            // A marker record opens the file; CBC can "decrypt" with the wrong key, so without it the key was wrong.
            let mut saw_marker = false;
            while reader.offset + 4 <= bytes.len() {
                cancel.check()?;
                let size = reader.integer(4)? as usize;
                if size > bytes.len() - reader.offset {
                    break;
                }
                let sealed = &bytes[reader.offset..reader.offset + size];
                reader.skip(size)?;
                let Some(plain) = crate::crypto::decrypt_cbc(sealed, key) else {
                    break;
                };
                let Some((&command, payload)) = plain.split_first() else {
                    break;
                };
                if command == 255 && payload.is_empty() {
                    saw_marker = true;
                }
                let _ = apply(
                    u64::from(command),
                    payload,
                    &mut tabs,
                    &mut windows,
                    &mut groups,
                );
            }
            if !saw_marker {
                return Err(Failure::new(
                    "locked",
                    "Couldn't decrypt the session file with this key",
                ));
            }
        }
        (5, None) if can_unlock => {
            return Err(Failure::new(
                "locked",
                "This session file is encrypted; unlock the browser first",
            ));
        }
        _ => return Err(unsupported()),
    }
    let mut out_tabs = Vec::new();
    let mut used = BTreeSet::new();
    let mut window_index = 0;
    for (window_id, window) in &windows {
        if window.kind != 0 {
            continue;
        }
        let mut ordered: Vec<(&i32, &Tab)> = tabs
            .iter()
            .filter(|(_, tab)| tab.window == *window_id && !tab.navigations.is_empty())
            .collect();
        ordered.sort_by_key(|(id, tab)| (tab.index, **id));
        let mut position = 0;
        for (_, tab) in ordered {
            let (url, title) = tab
                .navigations
                .range(tab.current..)
                .next()
                .or_else(|| tab.navigations.iter().next_back())
                .map(|(_, navigation)| navigation.clone())
                .expect("a tab with navigations");
            if url.is_empty() {
                continue;
            }
            let mut item = Map::new();
            item.insert("url".into(), json!(url));
            item.insert("title".into(), json!(title));
            item.insert("pinned".into(), json!(tab.pinned));
            item.insert("windowIndex".into(), json!(window_index));
            item.insert("active".into(), json!(position == window.selected));
            position += 1;
            if !tab.group.is_empty() {
                item.insert("groupId".into(), json!(tab.group));
                used.insert(tab.group.clone());
            }
            if tab.last_active != 0.0 {
                item.insert("lastActive".into(), json!(tab.last_active));
            }
            out_tabs.push(Value::Object(item));
        }
        window_index += 1;
    }
    let out_groups: Vec<Value> = used
        .iter()
        .map(|id| {
            groups.get(id).cloned().unwrap_or_else(
                || json!({"id": id, "title": "", "color": "grey", "collapsed": false}),
            )
        })
        .collect();
    Ok(json!({"tabs": out_tabs, "groups": out_groups}))
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// A tab's page: where it is, or for one that never loaded (pinned and essential tabs after a restart), where its pin
/// or its typed address points.
fn tab_page(tab: &Value) -> Option<(String, String)> {
    let entries = tab
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let entry = if entries.is_empty() {
        Value::Null
    } else {
        let last = entries.len() as i64 - 1;
        let index = tab
            .get("index")
            .and_then(Value::as_i64)
            .unwrap_or(entries.len() as i64);
        entries[(index - 1).clamp(0, last) as usize].clone()
    };
    let initial = tab
        .get("_zenPinnedInitialState")
        .filter(|state| state.is_object())
        .map(|state| state.get("entry").cloned().unwrap_or_else(|| json!({})))
        .unwrap_or(Value::Null);
    let url = [
        text(&entry, "url"),
        text(&initial, "url"),
        text(tab, "userTypedValue"),
    ]
    .into_iter()
    .find(|candidate| {
        !candidate.is_empty()
            && candidate != "about:blank"
            && !candidate.starts_with("about:newtab")
    })?;
    let mut title = text(&entry, "title");
    if title.is_empty() {
        title = text(&initial, "title");
    }
    Some((url, title))
}

/// The newest session store in a Firefox profile.
pub(crate) fn firefox_session_file(profile: &Path) -> Option<PathBuf> {
    let mut file: Option<(PathBuf, SystemTime)> = None;
    for name in [
        "sessionstore-backups/recovery.jsonlz4",
        "sessionstore.jsonlz4",
        "sessionstore-backups/previous.jsonlz4",
        "sessionstore.js",
    ] {
        let candidate = profile.join(name);
        let Ok(modified) = std::fs::metadata(&candidate).and_then(|metadata| metadata.modified())
        else {
            continue;
        };
        if file.as_ref().is_none_or(|(_, newest)| modified > *newest) {
            file = Some((candidate, modified));
        }
    }
    file.map(|(file, _)| file)
}

/// The newest session store in a Firefox profile, parsed.
fn firefox_session(profile: &Path) -> Result<Value> {
    let file = firefox_session_file(profile)
        .ok_or_else(|| Failure::new("notFound", "No Firefox session in this profile"))?;
    let mut bytes = read_bytes(&file)?;
    if file
        .extension()
        .is_some_and(|extension| extension == "jsonlz4")
    {
        bytes = decompress_moz_lz4(&bytes)?;
    }
    parse_json(&bytes)
}

/// The tabs a Firefox profile last had open, with its tab groups.
pub fn firefox_tabs(profile: &Path, cancel: Cancel<'_>) -> Result<Value> {
    firefox_session_tabs(&firefox_session(profile)?, cancel)
}

/// The tabs in a Firefox session store's JSON (already decompressed).
pub fn firefox_tabs_from_json(text: &str, cancel: Cancel<'_>) -> Result<Value> {
    firefox_session_tabs(&parse_json(text.as_bytes())?, cancel)
}

fn firefox_session_tabs(data: &Value, cancel: Cancel<'_>) -> Result<Value> {
    let mut tabs = Vec::new();
    let mut groups = Vec::new();
    let empty = Vec::new();
    for (window_index, window) in data
        .get("windows")
        .and_then(Value::as_array)
        .unwrap_or(&empty)
        .iter()
        .enumerate()
    {
        let selected = window.get("selected").and_then(Value::as_i64).unwrap_or(1) - 1;
        for (position, tab) in window
            .get("tabs")
            .and_then(Value::as_array)
            .unwrap_or(&empty)
            .iter()
            .enumerate()
        {
            cancel.check()?;
            // Zen's placeholder for an empty space or folder isn't a page.
            if flag(tab, "hidden") || flag(tab, "zenIsEmpty") {
                continue;
            }
            let Some((url, title)) = tab_page(tab) else {
                continue;
            };
            let mut item = Map::new();
            item.insert("url".into(), json!(url));
            item.insert("title".into(), json!(title));
            item.insert("pinned".into(), json!(flag(tab, "pinned")));
            item.insert("active".into(), json!(position as i64 == selected));
            item.insert("windowIndex".into(), json!(window_index));
            if let Some(group) = tab.get("groupId").filter(|group| group.is_string()) {
                item.insert("groupId".into(), group.clone());
            }
            if let Some(accessed) = tab.get("lastAccessed") {
                item.insert("lastActive".into(), accessed.clone());
            }
            tabs.push(Value::Object(item));
        }
        for group in window
            .get("groups")
            .and_then(Value::as_array)
            .unwrap_or(&empty)
        {
            let Some(id) = group.get("id").filter(|id| id.is_string()) else {
                continue;
            };
            let color = group.get("color").and_then(Value::as_str).unwrap_or("grey");
            groups.push(json!({"id": id, "title": text(group, "name"), "color": color, "collapsed": flag(group, "collapsed")}));
        }
    }
    Ok(json!({"tabs": tabs, "groups": groups}))
}

/// A space's pinned rows as they're built: pages, and folders (by Zen's id) that fill as their tabs come.
struct Row {
    folder: String,
    node: Map<String, Value>,
    rows: Vec<Row>,
}

fn add_row(
    rows: &mut Vec<Row>,
    node: Map<String, Value>,
    path: &[String],
    folders: &BTreeMap<String, Value>,
) {
    let Some((first, rest)) = path.split_first() else {
        rows.push(Row {
            folder: String::new(),
            node,
            rows: Vec::new(),
        });
        return;
    };
    let index = match rows.iter().position(|row| row.folder == *first) {
        Some(index) => index,
        None => {
            let name = folders
                .get(first)
                .map(|folder| text(folder, "name"))
                .unwrap_or_default();
            let mut folder = Map::new();
            folder.insert("type".into(), json!("folder"));
            folder.insert(
                "title".into(),
                json!(if name.is_empty() {
                    "Folder".to_owned()
                } else {
                    name
                }),
            );
            rows.push(Row {
                folder: first.clone(),
                node: folder,
                rows: Vec::new(),
            });
            rows.len() - 1
        }
    };
    add_row(&mut rows[index].rows, node, rest, folders);
}

fn row_nodes(rows: &[Row]) -> Value {
    Value::Array(
        rows.iter()
            .map(|row| {
                let mut node = row.node.clone();
                if !row.folder.is_empty() {
                    node.insert("children".into(), row_nodes(&row.rows));
                }
                Value::Object(node)
            })
            .collect(),
    )
}

/// A Zen space's icon, when it's an emoji rather than one of Zen's symbols.
fn zen_emoji(icon: &str) -> bool {
    !icon.is_empty()
        && icon.len() <= 32
        && icon.as_bytes()[0] >= 0x80
        && !icon.contains([':', '/', '.'])
}

/// Zen's gradient: each colour an `[r, g, b]` (or a `#hex`) in `c`.
fn zen_colors(space: &Value) -> Vec<Value> {
    let Some(theme) = space.get("theme").filter(|theme| theme.is_object()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for stop in theme
        .get("gradientColors")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(c) = stop.get("c") else { continue };
        if let Some(hex) = c.as_str().filter(|hex| hex.starts_with('#')) {
            out.push(json!(hex));
        } else if let Some(channels) = c
            .as_array()
            .filter(|c| c.len() >= 3 && c[..3].iter().all(Value::is_number))
        {
            let channel = |value: &Value| (value.as_f64().unwrap_or(0.0) as i64 & 255) as u8;
            out.push(json!(format!(
                "#{:02X}{:02X}{:02X}",
                channel(&channels[0]),
                channel(&channels[1]),
                channel(&channels[2])
            )));
        }
    }
    out
}

fn zen_spaces_in(top: &Value, profile_id: &str) -> Value {
    // zen-sessions keeps one set; the session store keeps a set per window.
    let windows = match top.get("windows").and_then(Value::as_array) {
        Some(windows) => windows.clone(),
        None => vec![top.clone()],
    };
    let mut space_list: Vec<Value> = Vec::new();
    let mut folder_list = Vec::new();
    let mut tabs = Vec::new();
    for window in windows.iter().filter(|window| window.is_object()) {
        if let Some(spaces) = window.get("spaces").and_then(Value::as_array)
            && space_list.is_empty()
            && !spaces.is_empty()
        {
            space_list = spaces.clone();
        }
        folder_list.extend(
            window
                .get("folders")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
        tabs.extend(
            window
                .get("tabs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
    }
    let mut order: Vec<String> = Vec::new();
    let mut spaces: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    let mut containers: BTreeMap<String, i64> = BTreeMap::new();
    for space in &space_list {
        let Some(uuid) = space.get("uuid").and_then(Value::as_str) else {
            continue;
        };
        if spaces.contains_key(uuid) {
            continue;
        }
        let name = text(space, "name");
        let mut out = Map::new();
        out.insert("id".into(), json!(uuid));
        out.insert(
            "name".into(),
            json!(if name.is_empty() {
                "Space".to_owned()
            } else {
                name
            }),
        );
        out.insert("profileId".into(), json!(profile_id));
        out.insert("pinned".into(), json!([]));
        out.insert("tabs".into(), json!([]));
        out.insert("favorites".into(), json!([]));
        let colors = zen_colors(space);
        if let Some(first) = colors.first() {
            out.insert("color".into(), first.clone());
            out.insert("colors".into(), Value::Array(colors));
        }
        let icon = text(space, "icon");
        if zen_emoji(&icon) {
            out.insert("emoji".into(), json!(icon));
        }
        spaces.insert(uuid.to_owned(), out);
        containers.insert(
            uuid.to_owned(),
            space
                .get("containerTabId")
                .and_then(Value::as_i64)
                .unwrap_or(0),
        );
        order.push(uuid.to_owned());
    }
    if order.is_empty() {
        return json!([]);
    }
    // Folders nest by parentId; a tab names its folder by groupId.
    let mut folders: BTreeMap<String, Value> = BTreeMap::new();
    for folder in &folder_list {
        if let Some(id) = folder.get("id").and_then(Value::as_str) {
            folders.insert(id.to_owned(), folder.clone());
        }
    }
    let chain = |mut id: String| {
        let mut out: Vec<String> = Vec::new();
        while folders.contains_key(&id) && out.len() < 8 && !out.contains(&id) {
            out.insert(0, id.clone());
            id = text(&folders[&id], "parentId");
        }
        out
    };
    let known = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .filter(|uuid| spaces.contains_key(*uuid))
            .map(str::to_owned)
            .unwrap_or_default()
    };
    // Pinned rows per space in Zen's order: a folder takes its first tab's place.
    let mut rows: BTreeMap<String, Vec<Row>> = BTreeMap::new();
    let mut essentials: Vec<(Value, i64)> = Vec::new();
    let mut unpinned: Vec<(String, Value)> = Vec::new();
    for tab in tabs.iter().filter(|tab| tab.is_object()) {
        if flag(tab, "zenIsEmpty") {
            continue;
        }
        let Some((url, title)) = tab_page(tab) else {
            continue;
        };
        let mut item = Map::new();
        item.insert("url".into(), json!(url));
        item.insert("title".into(), json!(title));
        item.insert("pinned".into(), json!(false));
        item.insert("windowIndex".into(), json!(0));
        item.insert("active".into(), json!(false));
        if let Some(accessed) = tab
            .get("lastAccessed")
            .filter(|accessed| accessed.is_number())
        {
            item.insert("lastActive".into(), accessed.clone());
        }
        if flag(tab, "zenEssential") {
            item.insert("pinned".into(), json!(true));
            essentials.push((
                Value::Object(item),
                tab.get("userContextId")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
            ));
            continue;
        }
        let group = text(tab, "groupId");
        let mut space = known(tab.get("zenWorkspace"));
        if space.is_empty()
            && let Some(folder) = folders.get(&group)
        {
            space = known(folder.get("workspaceId"));
        }
        if space.is_empty() {
            space = order[0].clone();
        }
        if flag(tab, "pinned") {
            let path = if group.is_empty() {
                Vec::new()
            } else {
                chain(group)
            };
            let mut node = Map::new();
            node.insert("type".into(), json!("url"));
            node.insert("title".into(), json!(title));
            node.insert("url".into(), json!(url));
            add_row(rows.entry(space).or_default(), node, &path, &folders);
        } else {
            unpinned.push((space, Value::Object(item)));
        }
    }
    for (space, item) in unpinned {
        spaces.get_mut(&space).expect("a known space")["tabs"]
            .as_array_mut()
            .expect("a list")
            .push(item);
    }
    let out: Vec<Value> = order
        .iter()
        .map(|uuid| {
            let mut space = spaces[uuid].clone();
            space.insert(
                "pinned".into(),
                row_nodes(rows.get(uuid).map(Vec::as_slice).unwrap_or_default()),
            );
            let favorites: Vec<Value> = essentials
                .iter()
                .filter(|(_, container)| *container == containers[uuid])
                .map(|(tab, _)| tab.clone())
                .collect();
            space.insert("favorites".into(), Value::Array(favorites));
            Value::Object(space)
        })
        .collect();
    Value::Array(out)
}

/// Zen's spaces in a session's JSON (zen-sessions or the session store, decompressed).
pub fn zen_spaces_from_json(text: &str, profile_id: &str) -> Result<Value> {
    Ok(zen_spaces_in(&parse_json(text.as_bytes())?, profile_id))
}

/// Zen's spaces (SpaceSuggestion), each with its pins, folders, open tabs and its container's essentials; empty for a
/// profile without them.
pub fn zen_spaces(profile: &Path, profile_id: &str) -> Result<Value> {
    let sessions = profile.join("zen-sessions.jsonlz4");
    if sessions.exists() {
        let found = zen_spaces_in(
            &parse_json(&decompress_moz_lz4(&read_bytes(&sessions)?)?)?,
            profile_id,
        );
        if found.as_array().is_some_and(|spaces| !spaces.is_empty()) {
            return Ok(found);
        }
    }
    match firefox_session(profile) {
        Ok(session) => Ok(zen_spaces_in(&session, profile_id)),
        Err(failure) if failure.code == "notFound" => Ok(json!([])),
        Err(failure) => Err(failure),
    }
}
