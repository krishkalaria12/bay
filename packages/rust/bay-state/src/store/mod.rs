//! The app's state while it runs and the commands that change it: the React Native app's store
//! (apps/browser/src/store), ported with its tests as the spec (tests/store_*.rs).
//!
//! The TypeScript store returns a new state from each command; here a command changes the state in place. Where the
//! TypeScript reads the state from before a change (a closed tab's successor, say), the port reads it before changing
//! anything. Maps keep their insertion order, as a JavaScript object's string keys do, and removing keeps the rest in
//! order, so every "the first group holding this tab" finds the same group.

mod groups;
mod hydrate;
mod model;
mod names;
mod openers;
mod placing;
mod splits;
mod tabs;
mod windows;

use std::cell::Cell;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::model::{
    BrowserWindow, ClosedGroup, ClosedTab, ClosedWindow, Extra, LocalFilePin, Navigation,
    PinnedFolder, Space, SplitView, Tab, TabGroup,
};

pub use groups::GroupPatch;
pub use model::{TabList, incognito_space_id, is_incognito_space, pinned_first, snapshot_tab};
pub use names::auto_group_name;
pub use placing::TabPlacement;
pub use tabs::NewTab;
pub use windows::CreateWindow;

pub const DEFAULT_SPACE_ID: &str = "default";
pub const MAX_CLOSED_TABS: usize = 50;
pub const MAX_CLOSED_WINDOWS: usize = 10;
pub const MAX_CLOSED_GROUPS: usize = 20;
pub const MAX_SPLIT_PANES: usize = 3;
/// How long a deleted group can be brought back.
pub const DELETED_GROUP_MS: f64 = 7.0 * 86_400_000.0;

/// What typed text means as an address, with the settings' search engine: @bay/core's `resolveInput`. The input
/// rules come from the input crate; the store takes them so it holds none itself.
pub type ResolveInput = fn(raw: &str, settings: &Settings) -> String;

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

/// The app's settings, kept as the session wrote them: a setting reads its default when it isn't there, and every
/// setting this build doesn't read is written back unchanged.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Settings(pub Map<String, Value>);

impl Settings {
    fn str(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Value::as_str)
    }

    fn flag(&self, key: &str) -> Option<bool> {
        self.0.get(key).and_then(Value::as_bool)
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

    pub fn site_muted(&self, host: &str) -> bool {
        self.0
            .get("mutedSites")
            .and_then(Value::as_array)
            .is_some_and(|sites| sites.iter().any(|site| site.as_str() == Some(host)))
    }
}

struct Env {
    clock: Clock,
    launch: String,
    ids: Cell<u64>,
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
    pub local_files: Vec<LocalFilePin>,
    pub splits: IndexMap<String, SplitView>,
    pub closed_tabs: Vec<ClosedTab>,
    pub closed_windows: Vec<ClosedWindow>,
    pub closed_groups: Vec<ClosedGroup>,
    pub deleted_groups: Vec<ClosedGroup>,
    pub cleaned_tabs: Vec<ClosedTab>,
    /// Each window's selected tabs.
    pub selection: HashMap<String, Vec<String>>,
    pub ui: Ui,
    pub window_ui: HashMap<String, WindowUi>,
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
            local_files: Vec::new(),
            splits: IndexMap::new(),
            closed_tabs: Vec::new(),
            closed_windows: Vec::new(),
            closed_groups: Vec::new(),
            deleted_groups: Vec::new(),
            cleaned_tabs: Vec::new(),
            selection: HashMap::new(),
            ui: Ui::default(),
            window_ui: HashMap::new(),
            extra: Extra::new(),
            env: Env {
                clock,
                launch,
                ids: Cell::new(0),
                navigations: Cell::new(0),
                resolve,
            },
        };
        browser.hydrate(Default::default(), false);
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
