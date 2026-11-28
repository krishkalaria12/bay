//! The app's state while it runs and the commands that change it: the React Native app's store
//! (apps/browser/src/store), ported with its tests as the spec (tests/store_*.rs).
//!
//! The TypeScript store returns a new state from each command; here a command changes the state in place. Where the
//! TypeScript reads the state from before a change (a closed tab's successor, say), the port reads it before changing
//! anything. Maps keep their insertion order, as a JavaScript object's string keys do, and removing keeps the rest in
//! order, so every "the first group holding this tab" finds the same group.

mod bookmarks;
mod engines;
mod folders;
mod groups;
mod history;
mod hydrate;
mod launch;
mod link_rules;
mod local_files;
mod model;
mod moves;
mod names;
mod openers;
mod organize;
mod pages;
mod peeks;
mod placing;
mod spaces;
mod splits;
mod tabs;
mod window_ui;
mod windows;

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::model::{
    BrowserWindow, ClosedGroup, ClosedTab, ClosedWindow, Download, Extra, LocalFilePin, Navigation,
    PinnedFolder, Space, SplitView, Tab, TabGroup,
};
use crate::session::Session;

pub use bookmarks::{
    BookmarkDraft, BookmarkNode, BookmarkUndo, Bookmarks, RemovedBookmarks, Roots, root_ids_for,
};
pub use engines::{
    CHROMIUM, PROTECTED_VIDEO_SITES, WEBKIT, protected_video_site, registrable_domain,
    site_domain_of, site_of, tab_pick,
};
pub use folders::{FolderMove, MAX_FOLDER_DEPTH, PinState, folder_depth, normalize_pinned_folders};
pub use groups::GroupPatch;
pub use history::{HistoryEntry, HistoryRow, MAX_HISTORY, without_visits_since};
pub use hydrate::{HydrateData, default_space};
pub use link_rules::{
    ExternalLinkRule, LinkDestination, LinkMatchType, matching_link_rule,
    normalize_external_link_rules, normalize_link_destination, validate_link_pattern,
};
pub use local_files::{FileDescriptor, local_file_path, normalize_local_files};
pub use model::{TabList, incognito_space_id, is_incognito_space, pinned_first, snapshot_tab};
pub use names::auto_group_name;
pub use names::tidy_tab_title;
pub use organize::{
    CLEAN_UP_AFTER_MS, GroupPlacement, MAX_CLEANED, PrivateSiteMutes, RECENT_TABS, TabTidyPlan,
    away_from_pin,
};
pub use pages::{LivePatch, TabPatch};
pub use peeks::{ClosedPeek, Peek, peek_site_of};
pub use placing::TabPlacement;
pub use spaces::{
    Isolated, SPACE_EMOJI, SpacePatch, engine_id_of, isolate_saved_spaces, profile_id_of,
    theme_of_color, unused_space_color, unused_space_look,
};
pub use splits::{OpenPane, PaneRefused, SplitSide};
pub use tabs::NewTab;
pub use window_ui::{FindState, MAX_DOWNLOADS, download_visible_in};
pub use windows::CreateWindow;

pub const DEFAULT_SPACE_ID: &str = "default";
pub const MAX_CLOSED_TABS: usize = 50;
pub const MAX_CLOSED_WINDOWS: usize = 10;
pub const MAX_CLOSED_GROUPS: usize = 20;
pub const MAX_SPLIT_PANES: usize = 3;
/// How long a deleted group can be brought back.
pub const DELETED_GROUP_MS: f64 = 7.0 * 86_400_000.0;

/// What typed text means as an address, with the settings' search engine (`resolve_typed`, the app's), or a test's.
pub type ResolveInput = fn(raw: &str, settings: &Settings) -> String;

/// @bay/core's `resolveInput` with the settings' search engine: an address as typed, fixed up, else a search.
pub fn resolve_typed(raw: &str, settings: &Settings) -> String {
    bay_core::input::url::resolve_input(raw, &settings.search_url_prefix())
}

/// Where the store's time comes from: the system's, in whole milliseconds as `Date.now()`, or a test's.
#[derive(Debug)]
pub enum Clock {
    System,
    Manual(Cell<f64>),
}

/// A tab's page as the engine last reported it. Never saved.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TabLive {
    pub is_loading: bool,
    pub progress: f64,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub playing_audio: bool,
    pub theme_color: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Ui {
    pub focused_window_id: Option<String>,
    /// Main and other windows, the most recently focused first.
    pub focus_order: Vec<String>,
}

/// The command bar.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Panel {
    pub open: bool,
    pub initial_text: String,
    /// "newTab" or "navigate".
    pub mode: Option<String>,
    pub session_id: Option<String>,
    /// The group a new tab from it joins.
    pub group_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WindowUi {
    pub panel: Panel,
    pub downloads_open: bool,
}

/// What the store asks of the engine: the app sends each to it (the engine ABI) and the engine reports back.
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    DeleteHistoryUrls {
        profile: String,
        urls: Vec<String>,
    },
    ImportHistory {
        profile: String,
        rows: Vec<HistoryRow>,
    },
    /// An address the app opens itself (settings, the new tab panel), from this window.
    OpenAppUrl {
        url: String,
        window_id: String,
    },
    /// A private window closed while this download ran: it stops.
    CancelDownload {
        id: String,
    },
    /// A private window closed: its WebKit pages' cookies and site data, kept in memory, go.
    EndPrivateSession {
        space_id: String,
    },
}

/// The app's settings, kept as the session wrote them: a setting reads its default when it isn't there, and every
/// setting this build doesn't read is written back unchanged.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Settings(pub Map<String, Value>);

impl Settings {
    /// The app's default settings, as the React Native app has them (scripts/default-settings.mjs writes the file).
    pub fn defaults() -> &'static Map<String, Value> {
        static DEFAULTS: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
        DEFAULTS.get_or_init(|| {
            serde_json::from_str(include_str!("default_settings.json")).unwrap_or_default()
        })
    }

    /// A setting as saved, else its default.
    pub fn value(&self, key: &str) -> Option<&Value> {
        self.0.get(key).or_else(|| Self::defaults().get(key))
    }

    pub(crate) fn str(&self, key: &str) -> Option<&str> {
        self.value(key).and_then(Value::as_str)
    }

    pub(crate) fn flag(&self, key: &str) -> Option<bool> {
        self.value(key).and_then(Value::as_bool)
    }

    pub fn set(&mut self, key: &str, value: impl Into<Value>) {
        self.0.insert(key.to_owned(), value.into());
    }

    pub fn default_space_id(&self) -> &str {
        self.str("defaultSpaceId").unwrap_or(DEFAULT_SPACE_ID)
    }

    /// New tabs go at the top of the list (the default) or the bottom.
    pub fn new_tabs_at_top(&self) -> bool {
        self.str("newTabPosition") != Some("bottom")
    }

    /// ⌘-clicking a link opens it in a group with its opener.
    pub fn cmd_click_creates_tab_group(&self) -> bool {
        self.flag("cmdClickCreatesTabGroup").unwrap_or(false)
    }

    /// A launch shows a new tab (the default) rather than the last one.
    pub fn launch_shows_new_tab(&self) -> bool {
        self.str("launchTab") != Some("lastTab")
    }

    /// A deleted space's mentions go: it's no longer the default, a link rule's or a translation exception's.
    pub fn forget_space(&mut self, id: &str, fallback: &str) {
        if self.default_space_id() == id {
            self.set("defaultSpaceId", fallback);
        }
        if let Some(Value::Object(sites)) = self.0.get_mut("neverTranslateSites") {
            sites.shift_remove(id);
        }
        let to_space = |v: &Value, space: &str| {
            v.get("kind").and_then(Value::as_str) == Some("space")
                && v.get("spaceId").and_then(Value::as_str) == Some(space)
        };
        if let Some(Value::Array(rules)) = self.0.get_mut("externalLinkRules") {
            rules.retain(|rule| !rule.get("destination").is_some_and(|d| to_space(d, id)));
        }
        if self
            .0
            .get("externalLinkDefault")
            .is_some_and(|d| to_space(d, id))
        {
            self.set(
                "externalLinkDefault",
                serde_json::json!({ "kind": "space", "spaceId": fallback }),
            );
        }
    }

    /// The default search engine's address (`%s` for the query): an extension's that controls it, else the chosen
    /// one among the built-in, custom and extension engines, else Google.
    pub fn search_url_prefix(&self) -> String {
        let list = |key: &str| {
            self.value(key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };
        let field = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::to_owned);
        let extensions = list("extensionSearchEngines");
        if let Some(url) = extensions
            .iter()
            .find(|e| e.get("isDefault").and_then(Value::as_bool) == Some(true))
            .and_then(|e| field(e, "url"))
        {
            return url;
        }
        let mut engines: Vec<(String, String)> = bay_core::input::engines::built_in_engines()
            .into_iter()
            .map(|e| (e.id, e.url))
            .collect();
        engines.extend(
            list("customSearchEngines")
                .iter()
                .filter_map(|e| Some((field(e, "id")?, field(e, "url")?))),
        );
        if let Some(legacy) = self.str("customSearchUrl").filter(|u| u.contains("%s")) {
            engines.push(("custom".to_owned(), legacy.to_owned()));
        }
        let mut seen = HashSet::new();
        for e in &extensions {
            if let (Some(id), Some(url)) = (field(e, "extensionId"), field(e, "url"))
                && seen.insert(id.clone())
            {
                engines.push((format!("extension:{id}"), url));
            }
        }
        let chosen = self.str("searchEngine");
        engines
            .iter()
            .find(|(id, _)| Some(id.as_str()) == chosen)
            .or(engines.first())
            .map_or_else(
                || bay_core::input::url::SEARCH_URL.to_owned(),
                |(_, url)| url.clone(),
            )
    }

    pub fn site_muted(&self, host: &str) -> bool {
        self.value("mutedSites")
            .and_then(Value::as_array)
            .is_some_and(|sites| sites.iter().any(|site| site.as_str() == Some(host)))
    }
}

struct Env {
    clock: Clock,
    launch: String,
    ids: Cell<u64>,
    /// xorshift64*: emoji and bookmark ids, seeded from the clock.
    random: Cell<u64>,
    navigations: Cell<u64>,
    resolve: ResolveInput,
}

/// The browser's state: spaces, windows, tabs and what was closed, as the TypeScript `BrowserState` holds them.
pub struct Browser {
    pub spaces: IndexMap<String, Space>,
    pub space_order: Vec<String>,
    pub orphaned_profile_data: Vec<String>,
    pub settings: Settings,
    pub windows: IndexMap<String, BrowserWindow>,
    pub window_order: Vec<String>,
    pub tabs: IndexMap<String, Tab>,
    /// Each list's tabs in sidebar order: a space's (by its id), a Little Bay's (by its window's).
    pub tab_lists: IndexMap<String, Vec<String>>,
    pub live: HashMap<String, TabLive>,
    pub groups: IndexMap<String, TabGroup>,
    pub pinned_folders: IndexMap<String, PinnedFolder>,
    pub local_files: IndexMap<String, LocalFilePin>,
    pub splits: IndexMap<String, SplitView>,
    pub closed_tabs: Vec<ClosedTab>,
    pub closed_windows: Vec<ClosedWindow>,
    pub closed_groups: Vec<ClosedGroup>,
    pub deleted_groups: Vec<ClosedGroup>,
    pub cleaned_tabs: Vec<ClosedTab>,
    /// The engine's history, as the app shows it, by space. Never saved.
    pub history: HashMap<String, Vec<HistoryEntry>>,
    /// Spaces whose history the engine has reported (until then it's empty, not "no history").
    pub history_ready: HashSet<String>,
    pub bookmarks: Bookmarks,
    pub bookmarks_ready: HashSet<String>,
    /// Recent bookmark removals Undo can put back, newest last. Not saved.
    pub bookmark_undo: Vec<BookmarkUndo>,
    /// WebKit is in this build and Bay hasn't switched it off (macOS); every page is Chromium's without it.
    webkit_on: bool,
    app_urls: Option<fn(&str) -> bool>,
    /// What the store asks of the engine, in order, until the app takes it (`take_effects`).
    pub effects: Vec<Effect>,
    /// Private windows' cleaned-up tabs and site mutes, by window: memory only, gone with the window.
    pub private_cleaned_tabs: HashMap<String, Vec<ClosedTab>>,
    pub private_site_mutes: PrivateSiteMutes,
    /// Folder moves and placements Undo can put back, newest last. Not saved.
    pub folder_move_undo: Vec<FolderMove>,
    /// Each window's selected tabs.
    pub selection: HashMap<String, Vec<String>>,
    pub ui: Ui,
    pub window_ui: HashMap<String, WindowUi>,
    /// Each window's peek, and the last one it closed.
    pub peeks: HashMap<String, Peek>,
    pub closed_peeks: HashMap<String, ClosedPeek>,
    /// Find in each tab's page, by tab.
    pub find: HashMap<String, FindState>,
    /// The Downloads list, newest first.
    pub downloads: Vec<Download>,
    /// Whether the app shows dark (the system's appearance or the person's choice).
    pub app_dark: bool,
    /// The session's fields this build doesn't model.
    pub extra: Extra,
    env: Env,
}

impl Browser {
    /// A browser with one space and no windows, as the app is before it reads its session.
    pub fn new(resolve: ResolveInput) -> Self {
        Self::with_clock(resolve, Clock::System)
    }

    pub fn with_clock(resolve: ResolveInput, clock: Clock) -> Self {
        let launch = format!(
            "{}{}",
            base36(now_ms() as u64),
            base36(u64::from(std::process::id()) % 1_679_616)
        );
        let seed = match &clock {
            Clock::System => now_ms().to_bits() ^ u64::from(std::process::id()),
            Clock::Manual(at) => at.get().to_bits(),
        };
        let mut browser = Self {
            spaces: IndexMap::new(),
            space_order: Vec::new(),
            orphaned_profile_data: Vec::new(),
            settings: Settings::default(),
            windows: IndexMap::new(),
            window_order: Vec::new(),
            tabs: IndexMap::new(),
            tab_lists: IndexMap::new(),
            live: HashMap::new(),
            groups: IndexMap::new(),
            pinned_folders: IndexMap::new(),
            local_files: IndexMap::new(),
            splits: IndexMap::new(),
            closed_tabs: Vec::new(),
            closed_windows: Vec::new(),
            closed_groups: Vec::new(),
            deleted_groups: Vec::new(),
            cleaned_tabs: Vec::new(),
            history: HashMap::new(),
            history_ready: HashSet::new(),
            bookmarks: Bookmarks::default(),
            bookmarks_ready: HashSet::new(),
            bookmark_undo: Vec::new(),
            webkit_on: cfg!(target_os = "macos"),
            app_urls: None,
            effects: Vec::new(),
            private_cleaned_tabs: HashMap::new(),
            private_site_mutes: HashMap::new(),
            folder_move_undo: Vec::new(),
            selection: HashMap::new(),
            ui: Ui::default(),
            window_ui: HashMap::new(),
            peeks: HashMap::new(),
            closed_peeks: HashMap::new(),
            find: HashMap::new(),
            downloads: Vec::new(),
            app_dark: true,
            extra: Extra::new(),
            env: Env {
                clock,
                launch,
                ids: Cell::new(0),
                random: Cell::new(seed | 1),
                navigations: Cell::new(0),
                resolve,
            },
        };
        browser.hydrate(Session::default(), false);
        browser
    }

    /// The time, in milliseconds since 1970.
    pub fn now(&self) -> f64 {
        match &self.env.clock {
            Clock::System => now_ms(),
            Clock::Manual(at) => at.get(),
        }
    }

    /// Moves a test's clock on. The system clock moves itself.
    pub fn advance(&self, ms: f64) {
        if let Clock::Manual(at) = &self.env.clock {
            at.set(at.get() + ms);
        }
    }

    /// An id no other record of this launch has: `<prefix>-<launch>-<n>`.
    pub fn new_id(&self, prefix: &str) -> String {
        let n = self.env.ids.get() + 1;
        self.env.ids.set(n);
        format!("{prefix}-{}-{}", self.env.launch, base36(n))
    }

    pub(crate) fn navigation_to(&self, url: &str, user_initiated: bool) -> Navigation {
        let seq = self.env.navigations.get() + 1;
        self.env.navigations.set(seq);
        Navigation {
            url: url.to_owned(),
            seq,
            user_initiated,
        }
    }

    /// What the store asked of the engine since the last call.
    pub fn take_effects(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }

    pub(crate) fn random_u32(&self) -> u32 {
        let mut x = self.env.random.get();
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.env.random.set(x);
        (x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 32) as u32
    }

    pub(crate) fn random_below(&self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            self.random_u32() as usize % n
        }
    }

    pub(crate) fn resolve_input(&self, raw: &str) -> String {
        (self.env.resolve)(raw, &self.settings)
    }

    /// Changes settings, as `updateSettings` does with the fields it's given.
    pub fn update_settings(&mut self, patch: impl IntoIterator<Item = (String, Value)>) {
        for (key, value) in patch {
            self.settings.0.insert(key, value);
        }
    }
}

/// The list's last `max` entries: the closed lists keep the most recent.
pub(crate) fn keep_last<T>(list: &mut Vec<T>, max: usize) {
    let over = list.len().saturating_sub(max);
    list.drain(..over);
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}
