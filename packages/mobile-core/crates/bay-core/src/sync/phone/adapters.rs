//! What the phone syncs, as records the computer's sync writes and reads (apps/browser/src/sync/adapters.ts): this
//! device's name, its open tabs, the bookmarks, the history, the spaces and their pins. The record shapes are the
//! computer's, field for field, so either side reads what the other wrote. A port of the Expo app's
//! `src/sync/adapters.ts`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use indexmap::{IndexMap, IndexSet};
use serde_json::{Map, Number, Value, json};

use crate::store::bookmarks::BOOKMARK_LIMIT;
use crate::store::bookmarks::BOOKMARKS_ROOT;
use crate::store::model::{SpaceChange, SyncedVisit};
use crate::store::{
    Action, BookmarkNode, Bookmarks, BrowserData, BrowserFolder, BrowserSpace, PinKind, PinnedSite,
    SpaceColor,
};
use crate::sync::order::assign_positions;
use crate::sync::scope::{Adapter, Extraction};

/// How far back history syncs: the computer's HISTORY_WINDOW_MS.
pub const HISTORY_WINDOW_MS: i64 = 90 * 86_400_000;

/// A visit read back within this is the same visit.
const SAME_VISIT_MS: f64 = 1.0;

/// The visits a history record keeps.
const MAX_VISIT_TIMES: usize = 20;

/// The open tabs a device lists for the others.
pub const MAX_DEVICE_TABS: usize = 30;

/// The folder the computer's bookmarks bar is on the phone, which has one tree.
pub const SYNC_BAR: &str = "bay-sync-bar";

/// The browser store as sync sees it: what it holds, whether it has been read from disk, and changing it.
pub trait StoreAccess: Send + Sync {
    fn data(&self) -> BrowserData;
    /// Whether the browsing state has been read: before, it's empty, which would read as everything deleted.
    fn ready(&self) -> bool;
    fn dispatch(&self, action: Action);
}

type Base<'a> = &'a dyn Fn(&str) -> Option<Value>;

fn object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn string<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key).and_then(Value::as_str)
}

/// A key that must be there, as a string or null.
fn nullable_string(map: &Map<String, Value>, key: &str) -> Option<Option<String>> {
    match map.get(key)? {
        Value::Null => Some(None),
        Value::String(text) => Some(Some(text.clone())),
        _ => None,
    }
}

fn number(map: &Map<String, Value>, key: &str) -> Option<Number> {
    map.get(key).and_then(|value| value.as_number().cloned())
}

/// A key that may be absent but, when there, holds `true`.
fn optional_true(map: &Map<String, Value>, key: &str) -> Option<bool> {
    match map.get(key) {
        None => Some(false),
        Some(Value::Bool(true)) => Some(true),
        Some(_) => None,
    }
}

fn as_f64(number: &Number) -> f64 {
    number.as_f64().unwrap_or(0.0)
}

/// A number as JSON writes it: whole numbers without a fraction, as JavaScript does.
fn json_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9e15 {
        json!(value as i64)
    } else {
        Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}

fn is_web(url: &str) -> bool {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    lower.starts_with("http:") || lower.starts_with("https:")
}

/// What syncs to the computer's history: its own rule, web and file pages.
fn kept_in_history(url: &str) -> bool {
    is_web(url)
        || url
            .get(..5)
            .is_some_and(|scheme| scheme.eq_ignore_ascii_case("file:"))
}

// MARK: Devices and tabs

/// This device's name, under `dev:` in the app's scope, where the computer lists the account's devices.
pub struct DeviceAdapter {
    pub key: String,
    pub name: String,
}

impl DeviceAdapter {
    pub fn new(device_id: &str, name: &str) -> Self {
        Self {
            key: format!("dev:{device_id}"),
            name: name.into(),
        }
    }
}

fn only(key: String) -> Option<crate::sync::scope::Ignore> {
    Some(Box::new(move |other: &str, _: Option<&Value>| other != key))
}

impl Adapter for DeviceAdapter {
    fn prefix(&self) -> &str {
        "dev:"
    }

    fn extract(&mut self, _base: Base) -> Option<Extraction> {
        Some(Extraction {
            values: IndexMap::from([(self.key.clone(), json!({ "n": self.name }))]),
            ignore: only(self.key.clone()),
        })
    }

    fn apply(
        &mut self,
        _visible: &IndexMap<String, Value>,
        _changed: &IndexSet<String>,
        _base: Base,
    ) -> bool {
        true
    }
}

/// The phone's open tabs in a space, newest first, for the other devices to open.
pub struct DeviceTabsAdapter {
    pub key: String,
    pub name: String,
    pub space_id: String,
    pub store: Arc<dyn StoreAccess>,
}

impl Adapter for DeviceTabsAdapter {
    fn prefix(&self) -> &str {
        "tabs:"
    }

    fn extract(&mut self, _base: Base) -> Option<Extraction> {
        let mut tabs: Vec<_> = self
            .store
            .data()
            .tabs
            .into_iter()
            .filter(|tab| tab.space_id == self.space_id && !tab.private && is_web(&tab.url))
            .collect();
        tabs.sort_by_key(|tab| std::cmp::Reverse(tab.last_visit));
        let open: Vec<Value> = tabs
            .into_iter()
            .take(MAX_DEVICE_TABS)
            .map(|tab| json!({ "u": tab.url, "t": tab.title }))
            .collect();
        Some(Extraction {
            values: IndexMap::from([(self.key.clone(), json!({ "n": self.name, "tabs": open }))]),
            ignore: only(self.key.clone()),
        })
    }

    fn apply(
        &mut self,
        _visible: &IndexMap<String, Value>,
        _changed: &IndexSet<String>,
        _base: Base,
    ) -> bool {
        true
    }
}

/// A device's own record taken out: what a device leaving the chain, or no longer listing its tabs, publishes.
pub struct RetiredAdapter {
    pub prefix: &'static str,
    pub key: String,
}

impl Adapter for RetiredAdapter {
    fn prefix(&self) -> &str {
        self.prefix
    }

    fn extract(&mut self, _base: Base) -> Option<Extraction> {
        Some(Extraction {
            values: IndexMap::new(),
            ignore: only(self.key.clone()),
        })
    }

    fn apply(
        &mut self,
        _visible: &IndexMap<String, Value>,
        _changed: &IndexSet<String>,
        _base: Base,
    ) -> bool {
        true
    }
}

// MARK: Bookmarks

/// A bookmark record: `k` its kind, `p` its parent (`other`, `bar` or a folder's id), `a` when added, `pos` its place.
#[derive(Debug, Clone)]
pub struct BookmarkValue {
    folder: bool,
    p: String,
    t: String,
    u: Option<String>,
    a: Number,
    pos: String,
}

fn read_bookmark(value: Option<&Value>) -> Option<BookmarkValue> {
    let map = object(value)?;
    let folder = match string(map, "k")? {
        "u" => false,
        "f" => true,
        _ => return None,
    };
    let u = match map.get("u") {
        None => None,
        Some(Value::String(url)) => Some(url.clone()),
        Some(_) => return None,
    };
    Some(BookmarkValue {
        folder,
        p: string(map, "p")?.into(),
        t: string(map, "t")?.into(),
        u,
        a: number(map, "a")?,
        pos: string(map, "pos")?.into(),
    })
}

/// Bookmarks. The computer has two trees, the bar and the other bookmarks; the phone one. The phone's tree is the
/// computer's other bookmarks, and the computer's bar is a folder at its top (`SYNC_BAR`). A bookmark's record key is
/// its id: the computer's UUID, or a phone's own id, which the computer maps to a UUID of its own.
pub struct BookmarksAdapter {
    pub store: Arc<dyn StoreAccess>,
    pub space_id: String,
    pub bar_title: String,
}

fn key_of(id: &str) -> &str {
    if id == BOOKMARKS_ROOT {
        "other"
    } else if id == SYNC_BAR {
        "bar"
    } else {
        id
    }
}

impl Adapter for BookmarksAdapter {
    fn prefix(&self) -> &str {
        "bm:"
    }

    fn extract(&mut self, base: Base) -> Option<Extraction> {
        if !self.store.ready() {
            return None;
        }
        let tree = self
            .store
            .data()
            .bookmarks
            .get(&self.space_id)
            .cloned()
            .unwrap_or_default();
        let mut values = IndexMap::new();
        let mut seen = HashSet::new();

        fn walk(
            tree: &Bookmarks,
            folder_id: &str,
            base: Base,
            values: &mut IndexMap<String, Value>,
            seen: &mut HashSet<String>,
        ) {
            let Some(BookmarkNode::Folder { children, .. }) = tree.get(folder_id) else {
                return;
            };
            if !seen.insert(folder_id.to_owned()) {
                return;
            }
            let parent = key_of(folder_id);
            let children: Vec<&String> = children
                .iter()
                .filter(|id| {
                    tree.contains_key(*id) && !(folder_id == BOOKMARKS_ROOT && *id == SYNC_BAR)
                })
                .collect();
            let known: Vec<Option<String>> = children
                .iter()
                .map(|id| {
                    read_bookmark(base(&format!("bm:{id}")).as_ref())
                        .filter(|known| known.p == parent)
                        .map(|known| known.pos)
                })
                .collect();
            let positions = assign_positions(&known);
            for (id, position) in children.into_iter().zip(positions) {
                let node = &tree[id];
                let (kind, title, added_at, url) = match node {
                    BookmarkNode::Url {
                        title,
                        added_at,
                        url,
                        ..
                    } => ("u", title, added_at, Some(url)),
                    BookmarkNode::Folder {
                        title, added_at, ..
                    } => ("f", title, added_at, None),
                };
                let mut value =
                    json!({ "k": kind, "p": parent, "t": title, "a": added_at, "pos": position });
                if let Some(url) = url {
                    value["u"] = json!(url);
                }
                values.insert(format!("bm:{id}"), value);
                if matches!(node, BookmarkNode::Folder { .. }) {
                    walk(tree, id, base, values, seen);
                }
            }
        }

        walk(&tree, BOOKMARKS_ROOT, base, &mut values, &mut seen);
        walk(&tree, SYNC_BAR, base, &mut values, &mut seen);
        Some(Extraction {
            values,
            ignore: None,
        })
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        _changed: &IndexSet<String>,
        _base: Base,
    ) -> bool {
        if !self.store.ready() {
            return false;
        }
        let records: IndexMap<String, BookmarkValue> = visible
            .iter()
            .filter_map(|(key, value)| {
                read_bookmark(Some(value)).map(|record| (key[3..].to_owned(), record))
            })
            .collect();
        self.store.dispatch(Action::ReplaceBookmarks {
            bookmarks: bookmark_tree(&records, &self.bar_title),
        });
        true
    }
}

/// JavaScript's default sort: by UTF-16 code units.
fn js_sorted<'a>(keys: impl Iterator<Item = &'a String>) -> Vec<&'a String> {
    let mut keys: Vec<&String> = keys.collect();
    keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    keys
}

/// The phone's tree from the bookmark records: orphans and loops go to the top, siblings in their order.
pub fn bookmark_tree(records: &IndexMap<String, BookmarkValue>, bar_title: &str) -> Bookmarks {
    let root_of = |key: &str| match key {
        "other" => Some(BOOKMARKS_ROOT),
        "bar" => Some(SYNC_BAR),
        _ => None,
    };
    let mut parent_of: HashMap<String, String> = HashMap::new();
    for (id, record) in records {
        let parent = root_of(&record.p).map(str::to_owned).unwrap_or_else(|| {
            if records.get(&record.p).is_some_and(|parent| parent.folder) {
                record.p.clone()
            } else {
                BOOKMARKS_ROOT.to_owned()
            }
        });
        parent_of.insert(id.clone(), parent);
    }
    let sorted = js_sorted(records.keys());
    // A folder inside itself, however far down: it moves to the top.
    for id in &sorted {
        let mut seen = HashSet::from([(*id).clone()]);
        let mut at = parent_of[*id].clone();
        while let Some(next) = parent_of.get(&at) {
            if seen.contains(&at) {
                parent_of.insert((*id).clone(), BOOKMARKS_ROOT.into());
                break;
            }
            seen.insert(at.clone());
            at = next.clone();
        }
    }
    let mut children: IndexMap<String, Vec<String>> = IndexMap::from([
        (BOOKMARKS_ROOT.to_owned(), Vec::new()),
        (SYNC_BAR.to_owned(), Vec::new()),
    ]);
    for id in &sorted {
        children
            .entry(parent_of[*id].clone())
            .or_default()
            .push((*id).clone());
    }
    let order = |a: &String, b: &String| {
        let (pa, pb) = (&records[a].pos, &records[b].pos);
        pa.encode_utf16()
            .cmp(pb.encode_utf16())
            .then_with(|| a.encode_utf16().cmp(b.encode_utf16()))
    };
    let mut tree = Bookmarks::new();
    for (count, (id, record)) in records.iter().enumerate() {
        if count + 1 > BOOKMARK_LIMIT {
            break;
        }
        let parent_id = parent_of[id].clone();
        let added_at = as_f64(&record.a) as i64;
        let node = if record.folder {
            BookmarkNode::Folder {
                id: id.clone(),
                parent_id: Some(parent_id),
                title: record.t.clone(),
                children: Vec::new(),
                added_at,
            }
        } else {
            BookmarkNode::Url {
                id: id.clone(),
                parent_id,
                title: record.t.clone(),
                url: record.u.clone().unwrap_or_default(),
                added_at,
            }
        };
        tree.insert(id.clone(), node);
    }
    let in_tree = |ids: &[String]| {
        ids.iter()
            .filter(|id| tree.contains_key(*id))
            .cloned()
            .collect::<Vec<_>>()
    };
    let mut bar = in_tree(&children[SYNC_BAR]);
    let mut top = in_tree(&children[BOOKMARKS_ROOT]);
    top.sort_by(order);
    bar.sort_by(order);
    let root_children = if bar.is_empty() {
        top
    } else {
        std::iter::once(SYNC_BAR.to_owned()).chain(top).collect()
    };
    let mut folders: Vec<(String, Vec<String>)> = Vec::new();
    for (parent, ids) in &children {
        if parent != BOOKMARKS_ROOT
            && parent != SYNC_BAR
            && matches!(tree.get(parent), Some(BookmarkNode::Folder { .. }))
        {
            let mut ids = in_tree(ids);
            ids.sort_by(order);
            folders.push((parent.clone(), ids));
        }
    }
    tree.insert(
        BOOKMARKS_ROOT.into(),
        BookmarkNode::Folder {
            id: BOOKMARKS_ROOT.into(),
            parent_id: None,
            title: String::new(),
            children: root_children,
            added_at: 0,
        },
    );
    if !bar.is_empty() {
        tree.insert(
            SYNC_BAR.into(),
            BookmarkNode::Folder {
                id: SYNC_BAR.into(),
                parent_id: Some(BOOKMARKS_ROOT.into()),
                title: bar_title.into(),
                children: bar,
                added_at: 0,
            },
        );
    }
    for (parent, ids) in folders {
        if let Some(BookmarkNode::Folder { children, .. }) = tree.get_mut(&parent) {
            *children = ids;
        }
    }
    tree
}

// MARK: History

#[derive(Debug, Clone)]
struct HistoryValue {
    t: String,
    n: Number,
    vt: Vec<Number>,
}

fn read_history(value: Option<&Value>) -> Option<HistoryValue> {
    let map = object(value)?;
    let vt = map
        .get("vt")?
        .as_array()?
        .iter()
        .map(|time| time.as_number().cloned())
        .collect::<Option<Vec<_>>>()?;
    Some(HistoryValue {
        t: string(map, "t")?.into(),
        n: number(map, "n")?,
        vt,
    })
}

impl HistoryValue {
    fn json(&self) -> Value {
        json!({ "t": self.t, "n": self.n, "vt": self.vt })
    }

    fn last_visit(&self) -> f64 {
        self.vt.iter().map(as_f64).fold(0.0, f64::max)
    }
}

/// History, as the computer syncs it: a record per page with its title, visit count and visit times. The phone keeps
/// its newest pages only (HISTORY_LIMIT), so a record at or below its oldest is out of its reach, not deleted.
pub struct HistoryAdapter {
    pub store: Arc<dyn StoreAccess>,
    pub space_id: String,
    pub limit: usize,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl Adapter for HistoryAdapter {
    fn prefix(&self) -> &str {
        "h:"
    }

    fn extract(&mut self, base: Base) -> Option<Extraction> {
        if !self.store.ready() {
            return None;
        }
        let since = ((self.now)() - HISTORY_WINDOW_MS) as f64;
        let entries: Vec<_> = self
            .store
            .data()
            .history
            .into_iter()
            .filter(|entry| entry.space_id == self.space_id)
            .collect();
        let floor = if entries.len() >= self.limit {
            entries
                .iter()
                .map(|entry| entry.last_visit as f64)
                .fold(f64::INFINITY, f64::min)
        } else {
            f64::NEG_INFINITY
        };
        let mut values = IndexMap::new();
        for entry in &entries {
            let last_visit = entry.last_visit as f64;
            if !kept_in_history(&entry.url) || last_visit < since {
                continue;
            }
            let key = format!("h:{}", entry.url);
            let known = read_history(base(&key).as_ref());
            let visited = known.as_ref().is_none_or(|known| {
                !known
                    .vt
                    .iter()
                    .any(|time| (as_f64(time) - last_visit).abs() <= SAME_VISIT_MS)
            });
            if let Some(known) = known.as_ref().filter(|_| !visited) {
                values.insert(key, known.json());
                continue;
            }
            let mut times: Vec<f64> = known
                .as_ref()
                .map(|known| known.vt.iter().map(as_f64).collect())
                .unwrap_or_default();
            times.push(last_visit);
            times.sort_by(f64::total_cmp);
            times.dedup();
            let times: Vec<Value> = times[times.len().saturating_sub(MAX_VISIT_TIMES)..]
                .iter()
                .map(|time| json_number(*time))
                .collect();
            let title = if !entry.title.is_empty() {
                entry.title.clone()
            } else {
                known
                    .as_ref()
                    .map(|known| known.t.clone())
                    .unwrap_or_default()
            };
            let visits =
                (entry.visits as f64).max(known.as_ref().map_or(0.0, |known| as_f64(&known.n)));
            values.insert(
                key,
                json!({ "t": title, "n": json_number(visits), "vt": times }),
            );
        }
        // Gone by age everywhere, or below what the phone keeps: not a deletion.
        let ignore = move |key: &str, known: Option<&Value>| {
            if !kept_in_history(&key[2..]) {
                return true;
            }
            read_history(known)
                .is_some_and(|known| known.last_visit() < since || known.last_visit() <= floor)
        };
        Some(Extraction {
            values,
            ignore: Some(Box::new(ignore)),
        })
    }

    fn edited_at(&self, value: &Value) -> Option<i64> {
        read_history(Some(value)).map(|record| record.last_visit() as i64)
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        _base: Base,
    ) -> bool {
        if !self.store.ready() {
            return false;
        }
        let since = ((self.now)() - HISTORY_WINDOW_MS) as f64;
        let data = self.store.data();
        let by_url: HashMap<&str, &crate::store::HistoryEntry> = data
            .history
            .iter()
            .filter(|entry| entry.space_id == self.space_id)
            .map(|entry| (entry.url.as_str(), entry))
            .collect();
        let (mut entries, mut removed) = (Vec::new(), Vec::new());
        for key in changed {
            let url = &key[2..];
            if !kept_in_history(url) {
                continue;
            }
            let old = by_url.get(url);
            match read_history(visible.get(key)) {
                Some(record) => {
                    let last_visit = record.last_visit();
                    if last_visit < since || last_visit == 0.0 {
                        continue;
                    }
                    entries.push(SyncedVisit {
                        url: url.into(),
                        title: if !record.t.is_empty() {
                            record.t.clone()
                        } else {
                            old.map(|old| old.title.clone()).unwrap_or_default()
                        },
                        favicon: old.and_then(|old| old.favicon.clone()),
                        visits: as_f64(&record.n)
                            .max(old.map_or(0.0, |old| old.visits as f64))
                            .max(1.0) as i64,
                        last_visit: last_visit.max(old.map_or(0.0, |old| old.last_visit as f64))
                            as i64,
                    });
                }
                None if old.is_some() => removed.push(url.to_owned()),
                None => {}
            }
        }
        if !entries.is_empty() || !removed.is_empty() {
            self.store
                .dispatch(Action::SyncHistory { entries, removed });
        }
        true
    }
}

// MARK: Spaces and pins

/// The computer's space colours as the phone's six: a colour the phone doesn't change stays the computer's.
pub fn phone_color(color: &str) -> SpaceColor {
    match color {
        "plum" | "purple" => SpaceColor::Violet,
        "pink" | "red" => SpaceColor::Red,
        "orange" | "yellow" => SpaceColor::Orange,
        "green" => SpaceColor::Green,
        "neutral" => SpaceColor::Gray,
        _ => SpaceColor::Blue,
    }
}

fn desktop_color(color: SpaceColor) -> &'static str {
    match color {
        SpaceColor::Gray => "neutral",
        SpaceColor::Blue => "blue",
        SpaceColor::Green => "green",
        SpaceColor::Orange => "orange",
        SpaceColor::Red => "red",
        SpaceColor::Violet => "purple",
    }
}

/// A space as the computer lists it under `prof:` in the app's scope: name, colour, emoji, and `d` on its default.
#[derive(Debug, Clone)]
pub struct ProfileRecord {
    pub n: String,
    pub c: String,
    pub i: Option<String>,
    pub d: bool,
    /// Every field, the ones the phone doesn't read too, to write back as they were.
    pub all: Map<String, Value>,
}

pub fn read_profile(value: Option<&Value>) -> Option<ProfileRecord> {
    let map = object(value)?;
    Some(ProfileRecord {
        n: string(map, "n")?.into(),
        c: string(map, "c")?.into(),
        i: nullable_string(map, "i")?,
        d: optional_true(map, "d")?,
        all: map.clone(),
    })
}

/// The computer's profiles, as the app's scope lists them: each one's sync id and record.
pub fn remote_profiles(records: &IndexMap<String, Value>) -> Vec<(String, ProfileRecord)> {
    records
        .iter()
        .filter_map(|(key, value)| {
            key.strip_prefix("prof:")
                .and_then(|id| read_profile(Some(value)).map(|record| (id.to_owned(), record)))
        })
        .collect()
}

/// The phone's spaces linked to the computer's (`links`, space id → sync id), under `prof:` in the app's scope. A space
/// renamed or given an emoji on either side changes on the other; the computer's colour is kept unless changed here.
pub struct ProfilesAdapter {
    pub store: Arc<dyn StoreAccess>,
    pub links: IndexMap<String, String>,
}

impl ProfilesAdapter {
    fn linked(&self) -> Vec<(BrowserSpace, String)> {
        let spaces = self.store.data().spaces;
        self.links
            .iter()
            .flat_map(|(id, sync_id)| {
                spaces
                    .iter()
                    .filter(|space| &space.id == id)
                    .map(|space| (space.clone(), sync_id.clone()))
                    .collect::<Vec<_>>()
            })
            .collect()
    }
}

impl Adapter for ProfilesAdapter {
    fn prefix(&self) -> &str {
        "prof:"
    }

    fn extract(&mut self, base: Base) -> Option<Extraction> {
        let mut values = IndexMap::new();
        for (space, sync_id) in self.linked() {
            let key = format!("prof:{sync_id}");
            let known = read_profile(base(&key).as_ref());
            let color = match &known {
                Some(known) if phone_color(&known.c) == space.color => known.c.clone(),
                _ => desktop_color(space.color).to_owned(),
            };
            let mut value = known.map(|known| known.all).unwrap_or_default();
            value.insert("n".into(), json!(space.name));
            value.insert("c".into(), json!(color));
            value.insert("i".into(), json!(space.icon));
            values.insert(key, Value::Object(value));
        }
        let mine: HashSet<String> = values.keys().cloned().collect();
        Some(Extraction {
            values,
            ignore: Some(Box::new(move |key: &str, _: Option<&Value>| {
                !mine.contains(key)
            })),
        })
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        _base: Base,
    ) -> bool {
        let updates: Vec<SpaceChange> = self
            .linked()
            .into_iter()
            .filter_map(|(space, sync_id)| {
                let key = format!("prof:{sync_id}");
                let record = read_profile(visible.get(&key)).filter(|_| changed.contains(&key))?;
                Some(SpaceChange {
                    id: space.id,
                    name: record.n,
                    color: phone_color(&record.c),
                    icon: record.i,
                })
            })
            .collect();
        if !updates.is_empty() {
            self.store.dispatch(Action::SyncSpaces {
                added: Vec::new(),
                changed: updates,
            });
        }
        true
    }
}

/// A pinned page as the computer writes it: `g` its folder, `r` a pinned row, `o` the rows' order.
#[derive(Debug, Clone)]
struct PinValue {
    g: Option<String>,
    u: String,
    t: Option<String>,
    i: Option<String>,
    ti: String,
    pos: String,
    r: bool,
    o: Option<String>,
    all: Map<String, Value>,
}

fn read_pin(value: Option<&Value>) -> Option<PinValue> {
    let map = object(value)?;
    let o = match map.get("o") {
        None => None,
        Some(Value::String(order)) => Some(order.clone()),
        Some(_) => return None,
    };
    Some(PinValue {
        g: nullable_string(map, "g")?,
        u: string(map, "u")?.into(),
        t: nullable_string(map, "t")?,
        i: nullable_string(map, "i")?,
        ti: string(map, "ti")?.into(),
        pos: string(map, "pos")?.into(),
        r: optional_true(map, "r")?,
        o,
        all: map.clone(),
    })
}

/// A pinned folder as the computer writes it; `f` a Pinned folder, else a pinned tab group.
#[derive(Debug, Clone)]
struct PinGroupValue {
    n: String,
    pos: String,
    all: Map<String, Value>,
}

fn read_pin_group(value: Option<&Value>) -> Option<PinGroupValue> {
    let map = object(value)?;
    nullable_string(map, "i")?;
    nullable_string(map, "c")?;
    optional_true(map, "f")?;
    Some(PinGroupValue {
        n: string(map, "n")?.into(),
        pos: string(map, "pos")?.into(),
        all: map.clone(),
    })
}

/// A space's Essentials, pinned rows and Pinned folders, under `pin:` in the space's scope, as the computer's sidebar
/// keeps them: `pin:t:<id>` a pinned page, `pin:g:<id>` a folder. What the computer keeps that the phone doesn't show
/// (a custom title or icon, a folder's colour and nesting) is carried over as it was.
pub struct PinsAdapter {
    pub store: Arc<dyn StoreAccess>,
    pub space_id: String,
}

impl PinsAdapter {
    fn pins(&self, data: &BrowserData) -> Vec<PinnedSite> {
        data.pinned_sites
            .iter()
            .filter(|site| site.space_id == self.space_id)
            .cloned()
            .collect()
    }

    fn folders(&self, data: &BrowserData) -> Vec<BrowserFolder> {
        data.folders
            .iter()
            .filter(|folder| folder.space_id == self.space_id)
            .cloned()
            .collect()
    }
}

impl Adapter for PinsAdapter {
    fn prefix(&self) -> &str {
        "pin:"
    }

    fn extract(&mut self, base: Base) -> Option<Extraction> {
        if !self.store.ready() {
            return None;
        }
        let data = self.store.data();
        let all = self.pins(&data);
        let pin_known = |id: &str| read_pin(base(&format!("pin:t:{id}")).as_ref());
        let rows: Vec<&PinnedSite> = all
            .iter()
            .filter(|site| site.kind == PinKind::Row)
            .collect();
        let row_order = assign_positions(
            &rows
                .iter()
                .map(|site| pin_known(&site.id).and_then(|known| known.o))
                .collect::<Vec<_>>(),
        );
        let row_position: HashMap<&str, &String> = rows
            .iter()
            .zip(&row_order)
            .map(|(site, order)| (site.id.as_str(), order))
            .collect();
        let mut values = IndexMap::new();

        let place =
            |list: &[&PinnedSite], group: Option<&str>, values: &mut IndexMap<String, Value>| {
                let known: Vec<Option<String>> = list
                    .iter()
                    .map(|site| {
                        pin_known(&site.id)
                            .filter(|known| known.g.as_deref() == group)
                            .map(|known| known.pos)
                    })
                    .collect();
                let positions = assign_positions(&known);
                for (site, position) in list.iter().zip(positions) {
                    let known = pin_known(&site.id);
                    let mut value = known
                        .as_ref()
                        .map(|known| known.all.clone())
                        .unwrap_or_default();
                    value.shift_remove("r");
                    value.shift_remove("o");
                    value.insert("g".into(), json!(group));
                    value.insert("u".into(), json!(site.url));
                    value.insert(
                        "t".into(),
                        json!(known.as_ref().and_then(|known| known.t.clone())),
                    );
                    value.insert(
                        "i".into(),
                        json!(known.as_ref().and_then(|known| known.i.clone())),
                    );
                    value.insert("ti".into(), json!(site.title));
                    value.insert("pos".into(), json!(position));
                    if site.kind == PinKind::Row {
                        value.insert("r".into(), json!(true));
                        value.insert("o".into(), json!(row_position[site.id.as_str()]));
                    }
                    values.insert(format!("pin:t:{}", site.id), Value::Object(value));
                }
            };

        let loose: Vec<&PinnedSite> = all
            .iter()
            .filter(|site| site.kind == PinKind::Essential || site.folder_id.is_none())
            .collect();
        place(&loose, None, &mut values);
        let groups = self.folders(&data);
        let group_positions = assign_positions(
            &groups
                .iter()
                .map(|folder| {
                    read_pin_group(base(&format!("pin:g:{}", folder.id)).as_ref())
                        .map(|known| known.pos)
                })
                .collect::<Vec<_>>(),
        );
        for (folder, position) in groups.iter().zip(group_positions) {
            let key = format!("pin:g:{}", folder.id);
            // A folder made here is a Pinned folder; one from the computer keeps what it was.
            let value = match read_pin_group(base(&key).as_ref()) {
                Some(known) => {
                    let mut value = known.all;
                    value.insert("n".into(), json!(folder.name));
                    value.insert("pos".into(), json!(position));
                    Value::Object(value)
                }
                None => {
                    json!({ "n": folder.name, "i": null, "c": null, "pos": position, "f": true })
                }
            };
            values.insert(key, value);
            let inside: Vec<&PinnedSite> = rows
                .iter()
                .filter(|site| site.folder_id.as_deref() == Some(folder.id.as_str()))
                .copied()
                .collect();
            place(&inside, Some(&folder.id), &mut values);
        }
        Some(Extraction {
            values,
            ignore: None,
        })
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        _changed: &IndexSet<String>,
        base: Base,
    ) -> bool {
        if !self.store.ready() {
            return false;
        }
        let mut groups: Vec<(String, PinGroupValue)> = Vec::new();
        let mut records: Vec<(String, PinValue)> = Vec::new();
        for (key, value) in visible {
            if let Some(id) = key.strip_prefix("pin:g:") {
                if let Some(group) = read_pin_group(Some(value)) {
                    groups.push((id.into(), group));
                }
            } else if let Some(id) = key.strip_prefix("pin:t:")
                && let Some(pin) = read_pin(Some(value)).filter(|pin| is_web(&pin.u))
            {
                records.push((id.into(), pin));
            }
        }
        let by_position = |a: &(String, String), b: &(String, String)| {
            a.1.encode_utf16()
                .cmp(b.1.encode_utf16())
                .then_with(|| a.0.encode_utf16().cmp(b.0.encode_utf16()))
        };
        groups.sort_by(|a, b| {
            by_position(
                &(a.0.clone(), a.1.pos.clone()),
                &(b.0.clone(), b.1.pos.clone()),
            )
        });
        records.sort_by(|a, b| {
            by_position(
                &(a.0.clone(), a.1.pos.clone()),
                &(b.0.clone(), b.1.pos.clone()),
            )
        });
        let group_ids: HashSet<&str> = groups.iter().map(|(id, _)| id.as_str()).collect();
        let folders: Vec<BrowserFolder> = groups
            .iter()
            .map(|(id, group)| BrowserFolder {
                id: id.clone(),
                space_id: String::new(),
                name: group.n.clone(),
            })
            .collect();
        let sorted: Vec<PinnedSite> = records
            .iter()
            .map(|(id, pin)| {
                let folder_id = pin
                    .g
                    .clone()
                    .filter(|group| !group.is_empty() && group_ids.contains(group.as_str()));
                PinnedSite {
                    id: id.clone(),
                    url: pin.u.clone(),
                    title: pin
                        .t
                        .clone()
                        .filter(|title| !title.is_empty())
                        .unwrap_or_else(|| pin.ti.clone()),
                    favicon: None,
                    space_id: String::new(),
                    kind: if folder_id.is_some() || pin.r {
                        PinKind::Row
                    } else {
                        PinKind::Essential
                    },
                    folder_id,
                }
            })
            .collect();
        // Rows keep the computer's order across the section (`o`); Essentials and a folder's rows their own.
        let row_order: HashMap<&str, &String> = records
            .iter()
            .map(|(id, pin)| (id.as_str(), pin.o.as_ref().unwrap_or(&pin.pos)))
            .collect();
        let essentials = sorted
            .iter()
            .filter(|site| site.kind == PinKind::Essential)
            .cloned();
        let mut rows: Vec<PinnedSite> = sorted
            .iter()
            .filter(|site| site.kind == PinKind::Row)
            .cloned()
            .collect();
        rows.sort_by(|a, b| {
            row_order[a.id.as_str()]
                .encode_utf16()
                .cmp(row_order[b.id.as_str()].encode_utf16())
        });
        // Pins and folders made here that the chain hasn't had yet stay: joining merges the phone's into the computer's.
        let data = self.store.data();
        let unsent: Vec<PinnedSite> = self
            .pins(&data)
            .into_iter()
            .filter(|site| {
                base(&format!("pin:t:{}", site.id)).is_none()
                    && !records.iter().any(|(id, _)| id == &site.id)
            })
            .collect();
        let unsent_folders = self.folders(&data).into_iter().filter(|folder| {
            base(&format!("pin:g:{}", folder.id)).is_none()
                && !group_ids.contains(folder.id.as_str())
        });
        let pins: Vec<PinnedSite> = essentials
            .chain(
                unsent
                    .iter()
                    .filter(|site| site.kind == PinKind::Essential)
                    .cloned(),
            )
            .chain(rows)
            .chain(
                unsent
                    .iter()
                    .filter(|site| site.kind == PinKind::Row)
                    .cloned(),
            )
            .collect();
        self.store.dispatch(Action::SyncSpacePins {
            space_id: self.space_id.clone(),
            pins,
            folders: folders.into_iter().chain(unsent_folders).collect(),
        });
        true
    }
}
