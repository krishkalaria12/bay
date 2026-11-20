//! The browser store's reducer: every change to the browsing state is an `Action`, and `reduce` gives the next state.
//! A port of the Expo app's `src/store/model.ts`, checked against what that file did in its own tests
//! (`tests/store_fixtures.rs`). `reduce` returns `None` when the action changes nothing, where the TypeScript returned
//! the same object, so the apps skip work for no-ops just as React did.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::bookmarks::{
    BOOKMARKS_ROOT, add_bookmarks, empty_bookmarks, folder_children, is_bookmarked, move_bookmark,
    remove_bookmark, remove_bookmarks_of, rename_bookmark, save_bookmark,
};
use super::parse::{
    parse_preferences, parse_reader_settings, parse_selectors, parse_site_setting_input,
    preferences_json,
};
use super::types::*;
use crate::js;

pub const TEXT_SIZE_MIN: i64 = 80;
pub const TEXT_SIZE_MAX: i64 = 200;
pub const TEXT_SIZE_STEP: i64 = 10;
pub const START_PAGE_HOURS: [Option<i64>; 4] = [None, Some(1), Some(4), Some(12)];

const DAY: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// How many pages each space's history keeps.
pub const HISTORY_LIMIT: usize = 1000;
pub const ARCHIVE_LIMIT: usize = 200;
pub const DOWNLOAD_LIMIT: usize = 100;
pub const FAVICON_LIMIT: usize = 500;
const NAME_LIMIT: usize = 40;

/// The emoji a space can wear, the desktop's set, in its order.
pub const SPACE_EMOJI: [&str; 35] = [
    "🏠", "✨", "📁", "🎯", "💡", "🧭", "🛍️", "🛒", "🎁", "🧪", "🔭", "💰", "🧾", "📈", "✈️", "🗺️",
    "🏝️", "📚", "🎧", "🎨", "🪴", "⌨️", "🤝", "🎓", "🏋️", "🍜", "☕️", "🎮", "🍿", "🚀", "💼", "🌱",
    "🧠", "📸", "🗃️",
];

/// The emoji a space can wear, in the space editor's order.
#[uniffi::export]
pub fn space_emoji() -> Vec<String> {
    SPACE_EMOJI.iter().map(|emoji| emoji.to_string()).collect()
}

/// The space colours, in the space editor's order.
#[uniffi::export]
pub fn space_colors() -> Vec<SpaceColor> {
    SPACE_COLORS.to_vec()
}

/// Room for one emoji, however many code points it takes.
pub const SPACE_ICON_LENGTH: usize = 16;

/// The one space every tab started in. Its history and bookmarks sync with the computer's default profile, so it
/// stays when other spaces are deleted.
pub const PERSONAL_SPACE_ID: &str = "personal";

/// The error a download keeps when Bay closed during it.
pub const INTERRUPTED_DOWNLOAD: &str = "Bay closed before it finished.";

pub fn personal_space() -> BrowserSpace {
    BrowserSpace {
        id: PERSONAL_SPACE_ID.into(),
        name: "Personal".into(),
        color: SpaceColor::Blue,
        icon: Some("🏠".into()),
    }
}

/// A new space's emoji: the first of the set no other space wears, past the house, which is the personal space's.
pub fn unused_space_icon(spaces: &[BrowserSpace]) -> String {
    let used: HashSet<Option<&str>> = spaces.iter().map(|space| space.icon.as_deref()).collect();
    SPACE_EMOJI
        .iter()
        .skip(1)
        .find(|emoji| !used.contains(&Some(**emoji)))
        .unwrap_or(&SPACE_EMOJI[1])
        .to_string()
}

/// Every space shows an emoji: one saved without gets a free one. The personal space without one takes the house;
/// a space that took the house by default before it gets another.
pub fn with_space_emoji(spaces: Vec<BrowserSpace>) -> Vec<BrowserSpace> {
    let house = SPACE_EMOJI[0];
    let personal_bare = spaces.iter().any(|space| {
        space.id == PERSONAL_SPACE_ID && space.icon.as_deref().is_none_or(str::is_empty)
    });
    let mut next: Vec<BrowserSpace> = spaces
        .into_iter()
        .map(|mut space| {
            if personal_bare {
                if space.id == PERSONAL_SPACE_ID {
                    space.icon = Some(house.into());
                } else if space.icon.as_deref() == Some(house) {
                    space.icon = None;
                }
            }
            space
        })
        .collect();
    for index in 0..next.len() {
        if next[index].icon.as_deref().is_none_or(str::is_empty) {
            next[index].icon = Some(unused_space_icon(&next));
        }
    }
    next
}

pub fn create_tab(id: &str, now: i64, url: &str, private: bool, space_id: &str) -> BrowserTab {
    BrowserTab {
        id: id.into(),
        url: url.into(),
        title: String::new(),
        favicon: None,
        created_at: now,
        last_visit: now,
        snapshot: None,
        private,
        space_id: space_id.into(),
        folder_id: None,
    }
}

pub fn initial_browser_data(tab: BrowserTab, preferences: BrowserPreferences) -> BrowserData {
    BrowserData {
        active_tab_ids: BTreeMap::from([(PERSONAL_SPACE_ID.to_owned(), tab.id.clone())]),
        active_tab_id: tab.id.clone(),
        tabs: vec![tab],
        spaces: vec![personal_space()],
        active_space_id: PERSONAL_SPACE_ID.into(),
        folders: Vec::new(),
        history: Vec::new(),
        pinned_sites: Vec::new(),
        bookmarks: BTreeMap::from([(PERSONAL_SPACE_ID.to_owned(), empty_bookmarks())]),
        archive: Vec::new(),
        downloads: Vec::new(),
        favicons: Default::default(),
        left_at: None,
        preferences,
    }
}

/// A space's history, newest first.
pub fn space_history<'a>(
    data: &'a BrowserData,
    space_id: &str,
) -> impl Iterator<Item = &'a HistoryEntry> {
    let space_id = space_id.to_owned();
    data.history
        .iter()
        .filter(move |entry| entry.space_id == space_id)
}

/// Newest first (a stable sort, as JavaScript's), one entry per page in each space, at most HISTORY_LIMIT a space.
pub(crate) fn cap_history(mut entries: Vec<HistoryEntry>) -> Vec<HistoryEntry> {
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.last_visit));
    let mut seen = HashSet::new();
    let mut counts: HashMap<String, usize> = HashMap::new();
    entries.retain(|entry| {
        let count = counts.get(&entry.space_id).copied().unwrap_or(0);
        if count >= HISTORY_LIMIT || !seen.insert((entry.space_id.clone(), entry.url.clone())) {
            return false;
        }
        counts.insert(entry.space_id.clone(), count + 1);
        true
    });
    entries
}

/// Imported visits merged into the history: a page already there adds the imported visits to its own and keeps the
/// later of the two times and its own title (unless it has none). Newest first, up to the limit. `None` when no
/// entry was usable.
pub fn merge_history(
    history: &[HistoryEntry],
    entries: &[HistoryEntry],
) -> Option<Vec<HistoryEntry>> {
    let mut order: Vec<(String, String)> = Vec::new();
    let mut pages: HashMap<(String, String), HistoryEntry> = HashMap::new();
    for entry in history {
        let key = (entry.space_id.clone(), entry.url.clone());
        if !pages.contains_key(&key) {
            order.push(key.clone());
        }
        pages.insert(key, entry.clone());
    }
    let mut changed = false;
    for entry in entries {
        if !js::is_web_address(&entry.url) || entry.last_visit < 0 || entry.visits <= 0 {
            continue;
        }
        changed = true;
        let key = (entry.space_id.clone(), entry.url.clone());
        let merged = match pages.get(&key) {
            Some(previous) => HistoryEntry {
                title: if previous.title.is_empty() {
                    entry.title.clone()
                } else {
                    previous.title.clone()
                },
                favicon: previous.favicon.clone().or_else(|| entry.favicon.clone()),
                visits: previous.visits + entry.visits,
                last_visit: previous.last_visit.max(entry.last_visit),
                ..previous.clone()
            },
            None => {
                order.push(key.clone());
                entry.clone()
            }
        };
        pages.insert(key, merged);
    }
    changed.then(|| {
        cap_history(
            order
                .into_iter()
                .filter_map(|key| pages.remove(&key))
                .collect(),
        )
    })
}

fn unique_by<T, K: std::hash::Hash + Eq>(entries: Vec<T>, key: impl Fn(&T) -> K) -> Vec<T> {
    let mut seen = HashSet::new();
    entries
        .into_iter()
        .filter(|entry| seen.insert(key(entry)))
        .collect()
}

/// Newest first, one entry per address: archiving a page again replaces its older copy.
fn archive_tabs(archive: &[ArchivedTab], tabs: &[BrowserTab], now: i64) -> Vec<ArchivedTab> {
    let urls: HashSet<&str> = tabs.iter().map(|tab| tab.url.as_str()).collect();
    let ids: HashSet<&str> = tabs.iter().map(|tab| tab.id.as_str()).collect();
    let mut next: Vec<ArchivedTab> = unique_by(tabs.to_vec(), |tab| tab.url.clone())
        .into_iter()
        .map(|tab| ArchivedTab {
            tab,
            closed_at: now,
        })
        .collect();
    next.extend(
        archive
            .iter()
            .filter(|entry| {
                !urls.contains(entry.tab.url.as_str()) && !ids.contains(entry.tab.id.as_str())
            })
            .cloned(),
    );
    next.truncate(ARCHIVE_LIMIT);
    next
}

/// What is saved: everything except private tabs and private downloads. When a private tab is current, the newest
/// saved tab is.
pub fn persisted_browser_data(data: &BrowserData) -> BrowserData {
    let mut saved = data.clone();
    saved.downloads.retain(|item| !item.private);
    if !data.tabs.iter().any(|tab| tab.private) {
        return saved;
    }
    saved.tabs.retain(|tab| !tab.private);
    if !saved.tabs.iter().any(|tab| tab.id == data.active_tab_id) {
        saved.active_tab_id = saved
            .tabs
            .last()
            .map(|tab| tab.id.clone())
            .unwrap_or_default();
    }
    let tabs = &saved.tabs;
    saved
        .active_tab_ids
        .retain(|_, tab_id| tabs.iter().any(|tab| &tab.id == tab_id));
    saved
}

/// A pin brought in from another browser: it becomes one of the current space's Essentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct PinDraft {
    pub id: String,
    pub url: String,
    pub title: String,
    pub favicon: Option<String>,
}

/// A page another device visited, for the personal space's history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct SyncedVisit {
    pub url: String,
    pub title: String,
    pub favicon: Option<String>,
    pub visits: i64,
    pub last_visit: i64,
}

/// A space the computer renamed, recoloured or gave another emoji.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct SpaceChange {
    pub id: String,
    pub name: String,
    pub color: SpaceColor,
    pub icon: Option<String>,
}

/// Reader settings as a control sends them: the size may be fractional and out of range until it is read.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct ReaderSettingsInput {
    pub theme: ReaderTheme,
    pub font: ReaderFont,
    pub size: f64,
}

/// A site's setting as Site Settings sends it, before it is snapped to the steps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct SiteSettingInput {
    pub text_size: Option<f64>,
    pub reader: bool,
    pub desktop_mode: bool,
    pub block_off: Vec<SiteBlockGroup>,
    pub swipe: Option<SwipeMode>,
    #[serde(default)]
    pub font: Option<SiteFont>,
    #[serde(default)]
    pub fullscreen: bool,
    #[serde(default)]
    pub force_dark: bool,
    #[serde(default = "on")]
    pub mini_player: bool,
}

fn on() -> bool {
    true
}

/// When Bay opens on a fresh start page: never, or after this many hours away. Its own type rather than an optional
/// number inside the update's option, which Kotlin can't tell from "no change" (`Long??` is `Long?`). Stored as the
/// preference is: `null` for never, else the hours.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum StartPageAfter {
    Never,
    Hours { hours: i64 },
}

impl From<Option<i64>> for StartPageAfter {
    fn from(hours: Option<i64>) -> Self {
        hours.map_or(Self::Never, |hours| Self::Hours { hours })
    }
}

impl Serialize for StartPageAfter {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Never => serializer.serialize_none(),
            Self::Hours { hours } => serializer.serialize_some(hours),
        }
    }
}

impl<'de> Deserialize<'de> for StartPageAfter {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Option::<i64>::deserialize(deserializer).map(Self::from)
    }
}

/// Preferences the settings screen changes in one step. An absent field stays.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<ThemeChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search_suggestions: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_amp: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_to_refresh: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_page_after_hours: Option<StartPageAfter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub youtube: Option<YouTubeCleanup>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub welcomed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_search_on_launch: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swipe_to_navigate: Option<SwipeMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_links: Option<AppLinks>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site_font: Option<SiteFont>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum DownloadEventState {
    Started,
    Progress,
    Finished,
    Failed,
    Cancelled,
}

/// A download update from the engine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct DownloadEvent {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub state: DownloadEventState,
    pub received: i64,
    pub total: i64,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub waiting: Option<String>,
    pub private: bool,
}

/// Every change to the browsing state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, uniffi::Enum)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    NewTab {
        tab: BrowserTab,
        background: bool,
    },
    ImportTabs {
        tabs: Vec<BrowserTab>,
    },
    ImportArchive {
        tabs: Vec<BrowserTab>,
        now: i64,
    },
    ImportHistory {
        entries: Vec<HistoryEntry>,
    },
    ImportPins {
        sites: Vec<PinDraft>,
    },
    AddBookmarks {
        space_id: String,
        nodes: Vec<BookmarkNode>,
    },
    /// Sync's tree, whole: built from every device's records. It is the personal space's.
    ReplaceBookmarks {
        bookmarks: Bookmarks,
    },
    /// Pages another device visited or removed, in the personal space's history.
    SyncHistory {
        entries: Vec<SyncedVisit>,
        removed: Vec<String>,
    },
    RemoveBookmark {
        space_id: String,
        id: String,
    },
    ToggleBookmark {
        space_id: String,
        bookmark: BookmarkNode,
    },
    /// A page saved into a folder of a space (`bookmark`'s parent): moved there and renamed if the space has it already.
    SaveBookmark {
        space_id: String,
        bookmark: BookmarkNode,
    },
    /// A bookmark or folder moved into `parent_id`, at `index` among its children (at the end without one).
    MoveBookmark {
        space_id: String,
        id: String,
        parent_id: String,
        #[serde(default)]
        index: Option<i64>,
    },
    /// A bookmark's new title (and address), or a folder's new name.
    RenameBookmark {
        space_id: String,
        id: String,
        title: String,
        #[serde(default)]
        url: Option<String>,
    },
    ActivateTab {
        id: String,
        now: i64,
    },
    UpdateTab {
        id: String,
        update: TabUpdate,
    },
    Visit {
        space_id: String,
        url: String,
        title: String,
        favicon: Option<String>,
        now: i64,
    },
    PageTitle {
        url: String,
        title: String,
    },
    CloseTab {
        id: String,
        now: i64,
        fallback: BrowserTab,
    },
    RestoreTab {
        id: String,
        restored_id: String,
        now: i64,
    },
    CreateSpace {
        space: BrowserSpace,
        blank_tab: BrowserTab,
    },
    RenameSpace {
        id: String,
        name: String,
    },
    SetSpaceIcon {
        id: String,
        icon: Option<String>,
    },
    SetSpaceColor {
        id: String,
        color: SpaceColor,
    },
    ReorderSpace {
        id: String,
        to: i64,
    },
    /// Deletes a space with its tabs, pins, folders, history, bookmarks and archive; `blank_tab` opens if no tab is left.
    DeleteSpace {
        id: String,
        blank_tab: BrowserTab,
    },
    SelectSpace {
        id: String,
        #[serde(default)]
        blank_tab: Option<BrowserTab>,
    },
    NewFolder {
        folder: BrowserFolder,
    },
    RenameFolder {
        id: String,
        name: String,
    },
    DeleteFolder {
        id: String,
    },
    MoveTab {
        id: String,
        space_id: String,
        folder_id: Option<String>,
    },
    PinSite {
        tab_id: String,
        pin_id: String,
        kind: PinKind,
        #[serde(default)]
        folder_id: Option<String>,
    },
    /// A pin made an Essential or a pinned row, into a folder or out of one, and put beside the pin `beside` when given
    /// (a row dragged onto another): after it when `after`, else before it.
    MovePin {
        id: String,
        kind: PinKind,
        folder_id: Option<String>,
        #[serde(default)]
        beside: Option<String>,
        #[serde(default)]
        after: bool,
    },
    SyncSpacePins {
        space_id: String,
        pins: Vec<PinnedSite>,
        folders: Vec<BrowserFolder>,
    },
    SyncSpaces {
        added: Vec<BrowserSpace>,
        changed: Vec<SpaceChange>,
    },
    RemovePin {
        id: String,
    },
    AddPin {
        site: PinnedSite,
        index: i64,
    },
    RemoveHistory {
        space_id: String,
        url: String,
    },
    /// One space's history, or every space's.
    ClearHistory {
        #[serde(default)]
        space_id: Option<String>,
    },
    Favicon {
        host: String,
        uri: Option<String>,
    },
    RemoveArchived {
        id: String,
    },
    /// One space's archive, or every space's.
    ClearArchive {
        #[serde(default)]
        space_id: Option<String>,
    },
    Wallpaper {
        id: WallpaperId,
        #[serde(default)]
        photo: Option<String>,
    },
    /// Choosing the custom engine carries its address; one that isn't https with `%s` is refused.
    SearchEngine {
        id: String,
        #[serde(default)]
        custom_url: Option<String>,
    },
    ArchiveDays {
        days: Option<f64>,
    },
    ArchiveStale {
        now: i64,
    },
    BlockContent {
        enabled: bool,
    },
    PauseBlocking {
        host: String,
        paused: bool,
    },
    /// A first-run tip was shown and put away.
    TipSeen {
        id: TipId,
    },
    /// "Show the welcome again": the welcome and every tip come back.
    WelcomeAgain,
    LockPrivateTabs {
        enabled: bool,
    },
    Preferences {
        update: PreferencesUpdate,
    },
    Left {
        now: i64,
    },
    #[serde(rename = "reader-settings")]
    ReaderSettingsChange {
        settings: ReaderSettingsInput,
    },
    HiddenElements {
        host: String,
        selectors: Vec<String>,
    },
    SiteSettings {
        host: String,
        update: SiteSettingInput,
    },
    Download {
        update: DownloadEvent,
        now: i64,
    },
    RemoveDownload {
        id: String,
    },
    ClearDownloads,
}

fn has_space(data: &BrowserData, id: &str) -> bool {
    data.spaces.iter().any(|space| space.id == id)
}

fn space_bookmarks(data: &BrowserData, space_id: &str) -> Bookmarks {
    data.bookmarks
        .get(space_id)
        .cloned()
        .unwrap_or_else(empty_bookmarks)
}

/// Replaces one space's bookmark tree.
fn with_space_bookmarks(
    data: &BrowserData,
    space_id: &str,
    bookmarks: Option<Bookmarks>,
) -> Option<BrowserData> {
    let bookmarks = bookmarks?;
    let mut next = data.clone();
    next.bookmarks.insert(space_id.into(), bookmarks);
    Some(next)
}

/// Whether a bookmark's title is only its page's address (nothing, the address, or the address without its scheme or
/// `www.`), as when it was saved before the page had a title.
fn is_address_title(title: &str, url: &str) -> bool {
    let bare = url.split_once("://").map_or(url, |(_, rest)| rest);
    let bare = bare.strip_prefix("www.").unwrap_or(bare);
    let title = title.trim().trim_end_matches('/');
    title.is_empty()
        || title == url.trim_end_matches('/')
        || title == bare.trim_end_matches('/')
        || title.strip_prefix("www.") == Some(bare.trim_end_matches('/'))
}

/// The next state after `action`, or `None` when it changes nothing.
pub fn reduce(data: &BrowserData, action: &Action) -> Option<BrowserData> {
    let mut next = data.clone();
    match action {
        Action::NewTab { tab, background } => {
            if data.tabs.iter().any(|entry| entry.id == tab.id) {
                return None;
            }
            next.tabs.push(tab.clone());
            if !background {
                next.active_tab_id = tab.id.clone();
                next.active_tab_ids
                    .insert(tab.space_id.clone(), tab.id.clone());
            }
        }

        Action::ImportTabs { tabs } => {
            // A link that is already open stays where it is; importing again shouldn't duplicate tabs.
            let open: HashSet<&str> = data.tabs.iter().map(|tab| tab.url.as_str()).collect();
            let fresh: Vec<BrowserTab> = tabs
                .iter()
                .filter(|tab| !tab.url.is_empty() && !open.contains(tab.url.as_str()))
                .cloned()
                .collect();
            if fresh.is_empty() {
                return None;
            }
            next.tabs.extend(fresh);
        }

        Action::ImportArchive { tabs, now } => {
            let tabs: Vec<BrowserTab> = tabs
                .iter()
                .filter(|tab| !tab.url.is_empty() && !tab.private)
                .cloned()
                .collect();
            if tabs.is_empty() {
                return None;
            }
            next.archive = archive_tabs(&data.archive, &tabs, *now);
        }

        Action::ImportHistory { entries } => next.history = merge_history(&data.history, entries)?,

        Action::ImportPins { sites } => {
            // Pins come after the ones already there; a site pinned already keeps its place.
            let pinned: HashSet<&str> = data
                .pinned_sites
                .iter()
                .filter(|site| site.space_id == data.active_space_id)
                .map(|site| site.url.as_str())
                .collect();
            let sites = unique_by(
                sites
                    .iter()
                    .filter(|site| {
                        js::is_web_address(&site.url) && !pinned.contains(site.url.as_str())
                    })
                    .cloned()
                    .collect(),
                |site| site.url.clone(),
            );
            if sites.is_empty() {
                return None;
            }
            // Another browser's favourites become the current space's Essentials.
            next.pinned_sites
                .extend(sites.into_iter().map(|site| PinnedSite {
                    id: site.id,
                    url: site.url,
                    title: site.title,
                    favicon: site.favicon,
                    space_id: data.active_space_id.clone(),
                    kind: PinKind::Essential,
                    folder_id: None,
                }));
        }

        Action::AddBookmarks { space_id, nodes } => {
            if !has_space(data, space_id) {
                return None;
            }
            return with_space_bookmarks(
                data,
                space_id,
                add_bookmarks(&space_bookmarks(data, space_id), nodes),
            );
        }

        Action::ReplaceBookmarks { bookmarks } => {
            // A tree without its root isn't one: the store keeps what it has.
            folder_children(bookmarks, BOOKMARKS_ROOT)?;
            next.bookmarks
                .insert(PERSONAL_SPACE_ID.into(), bookmarks.clone());
        }

        Action::SyncHistory { entries, removed } => {
            let removed: HashSet<&str> = removed.iter().map(String::as_str).collect();
            let own = |entry: &HistoryEntry| entry.space_id == PERSONAL_SPACE_ID;
            let mut order: Vec<String> = Vec::new();
            let mut pages: HashMap<String, HistoryEntry> = HashMap::new();
            for entry in data
                .history
                .iter()
                .filter(|entry| own(entry) && !removed.contains(entry.url.as_str()))
            {
                if pages.insert(entry.url.clone(), entry.clone()).is_none() {
                    order.push(entry.url.clone());
                }
            }
            // Another device's record holds every visit it knows: it replaces the count and the time, never adds to them.
            for entry in entries {
                if js::is_web_address(&entry.url) && entry.last_visit >= 0 {
                    let visit = HistoryEntry {
                        space_id: PERSONAL_SPACE_ID.into(),
                        url: entry.url.clone(),
                        title: entry.title.clone(),
                        favicon: entry.favicon.clone(),
                        visits: entry.visits,
                        last_visit: entry.last_visit,
                    };
                    if pages.insert(entry.url.clone(), visit).is_none() {
                        order.push(entry.url.clone());
                    }
                }
            }
            let mut history: Vec<HistoryEntry> = data
                .history
                .iter()
                .filter(|entry| !own(entry))
                .cloned()
                .collect();
            history.extend(order.into_iter().filter_map(|url| pages.remove(&url)));
            next.history = cap_history(history);
        }

        Action::RemoveBookmark { space_id, id } => {
            return with_space_bookmarks(
                data,
                space_id,
                remove_bookmark(&space_bookmarks(data, space_id), id),
            );
        }

        Action::SaveBookmark { space_id, bookmark } => {
            let BookmarkNode::Url { url, .. } = bookmark else {
                return None;
            };
            if !js::is_web_address(url) || !has_space(data, space_id) {
                return None;
            }
            return with_space_bookmarks(
                data,
                space_id,
                save_bookmark(&space_bookmarks(data, space_id), bookmark),
            );
        }

        Action::MoveBookmark {
            space_id,
            id,
            parent_id,
            index,
        } => {
            let index = index.and_then(|index| usize::try_from(index).ok());
            return with_space_bookmarks(
                data,
                space_id,
                move_bookmark(&space_bookmarks(data, space_id), id, parent_id, index),
            );
        }

        Action::RenameBookmark {
            space_id,
            id,
            title,
            url,
        } => {
            return with_space_bookmarks(
                data,
                space_id,
                rename_bookmark(&space_bookmarks(data, space_id), id, title, url.as_deref()),
            );
        }

        Action::ToggleBookmark { space_id, bookmark } => {
            // A page bookmarked anywhere in the space is unbookmarked there; otherwise it joins the top of its tree, last.
            let BookmarkNode::Url { url, .. } = bookmark else {
                return None;
            };
            if !js::is_web_address(url) || !has_space(data, space_id) {
                return None;
            }
            let tree = space_bookmarks(data, space_id);
            let changed = if is_bookmarked(&tree, url) {
                Some(remove_bookmarks_of(&tree, url))
            } else {
                add_bookmarks(&tree, std::slice::from_ref(bookmark))
            };
            return with_space_bookmarks(data, space_id, changed);
        }

        Action::ActivateTab { id, now } => {
            let tab = next.tabs.iter_mut().find(|entry| &entry.id == id)?;
            tab.last_visit = *now;
            let space = tab.space_id.clone();
            next.active_tab_id = id.clone();
            next.active_tab_ids.insert(space, id.clone());
        }

        Action::UpdateTab { id, update } => {
            let tab = next.tabs.iter_mut().find(|entry| &entry.id == id)?;
            let before = tab.clone();
            if let Some(url) = &update.url {
                tab.url = url.clone();
            }
            if let Some(title) = &update.title {
                tab.title = title.clone();
            }
            if let Some(favicon) = &update.favicon {
                tab.favicon = favicon.clone();
            }
            if let Some(last_visit) = update.last_visit {
                tab.last_visit = last_visit;
            }
            if let Some(snapshot) = &update.snapshot {
                tab.snapshot = snapshot.clone();
            }
            if *tab == before {
                return None;
            }
        }

        Action::Visit {
            space_id,
            url,
            title,
            favicon,
            now,
        } => {
            if !js::is_web_address(url) || !has_space(data, space_id) {
                return None;
            }
            let same = |entry: &HistoryEntry| &entry.space_id == space_id && &entry.url == url;
            let previous = data.history.iter().find(|entry| same(entry));
            let visit = HistoryEntry {
                space_id: space_id.clone(),
                url: url.clone(),
                title: title.clone(),
                favicon: favicon
                    .clone()
                    .or_else(|| previous.and_then(|entry| entry.favicon.clone())),
                visits: previous.map_or(0, |entry| entry.visits) + 1,
                last_visit: *now,
            };
            let mut history = vec![visit];
            history.extend(data.history.iter().filter(|entry| !same(entry)).cloned());
            next.history = cap_history(history);
        }

        Action::PageTitle { url, title } => {
            // Titles often arrive after the load finishes and the visit is saved, or after the page is bookmarked; a
            // bookmark saved before then holds the address in place of a title, and takes the page's. A title someone
            // gave it stays.
            let stale = |entry: &HistoryEntry| &entry.url == url && &entry.title != title;
            let placeholder = |node: &BookmarkNode| {
                matches!(node, BookmarkNode::Url { url: saved, title: named, .. }
                    if saved == url && named != title && is_address_title(named, url))
            };
            let renames = data
                .bookmarks
                .values()
                .any(|tree| tree.values().any(placeholder));
            if title.is_empty() || (!data.history.iter().any(stale) && !renames) {
                return None;
            }
            for entry in next.history.iter_mut().filter(|entry| stale(entry)) {
                entry.title = title.clone();
            }
            for tree in next.bookmarks.values_mut() {
                for node in tree.values_mut() {
                    if placeholder(node)
                        && let BookmarkNode::Url { title: named, .. } = node
                    {
                        *named = title.clone();
                    }
                }
            }
        }

        Action::CloseTab { id, now, fallback } => {
            let index = data.tabs.iter().position(|tab| &tab.id == id)?;
            let tab = &data.tabs[index];
            let remaining: Vec<BrowserTab> = data
                .tabs
                .iter()
                .filter(|entry| &entry.id != id)
                .cloned()
                .collect();
            let tabs = if remaining.is_empty() {
                vec![fallback.clone()]
            } else {
                remaining.clone()
            };
            // The space's own current pointer follows whichever neighbour is closest in list order.
            if data.active_tab_ids.get(&tab.space_id) == Some(id) {
                let in_space: Vec<&BrowserTab> = remaining
                    .iter()
                    .filter(|entry| entry.space_id == tab.space_id)
                    .collect();
                if in_space.is_empty() {
                    next.active_tab_ids.remove(&tab.space_id);
                } else {
                    next.active_tab_ids.insert(
                        tab.space_id.clone(),
                        in_space[index.min(in_space.len() - 1)].id.clone(),
                    );
                }
            }
            // When the tab on screen closes, its space is next in line; without a same-space tab left, find any tab.
            if &data.active_tab_id == id {
                next.active_tab_id = tabs
                    .iter()
                    .find(|entry| entry.space_id == tab.space_id)
                    .unwrap_or(&tabs[index.min(tabs.len() - 1)])
                    .id
                    .clone();
            }
            // Private tabs leave nothing behind.
            if !tab.url.is_empty() && !tab.private {
                next.archive = archive_tabs(&data.archive, std::slice::from_ref(tab), *now);
            }
            next.tabs = tabs;
        }

        Action::RestoreTab {
            id,
            restored_id,
            now,
        } => {
            let archived = data.archive.iter().find(|tab| &tab.tab.id == id)?;
            let mut restored = archived.tab.clone();
            restored.id = restored_id.clone();
            if !has_space(data, &restored.space_id) {
                restored.space_id = PERSONAL_SPACE_ID.into();
            }
            restored.last_visit = *now;
            next.active_tab_id = restored.id.clone();
            next.active_tab_ids
                .insert(restored.space_id.clone(), restored.id.clone());
            next.tabs.push(restored);
            next.archive.retain(|entry| &entry.tab.id != id);
        }

        Action::CreateSpace { space, blank_tab } => {
            next.spaces.push(space.clone());
            next.tabs.push(blank_tab.clone());
            next.active_space_id = space.id.clone();
            next.active_tab_ids
                .insert(space.id.clone(), blank_tab.id.clone());
            next.active_tab_id = blank_tab.id.clone();
        }

        Action::RenameSpace { id, name } => {
            let name = js::trim(name);
            if !has_space(data, id) || name.is_empty() {
                return None;
            }
            for space in next.spaces.iter_mut().filter(|space| &space.id == id) {
                space.name = js::slice(name, NAME_LIMIT);
            }
        }

        Action::SetSpaceIcon { id, icon } => {
            // Every space wears an emoji: none isn't a choice.
            let icon = icon
                .as_deref()
                .map(|icon| js::slice(js::trim(icon), SPACE_ICON_LENGTH))
                .filter(|icon| !icon.is_empty())?;
            if !has_space(data, id) {
                return None;
            }
            for space in next.spaces.iter_mut().filter(|space| &space.id == id) {
                space.icon = Some(icon.clone());
            }
        }

        Action::SetSpaceColor { id, color } => {
            if !data
                .spaces
                .iter()
                .any(|space| &space.id == id && space.color != *color)
            {
                return None;
            }
            for space in next.spaces.iter_mut().filter(|space| &space.id == id) {
                space.color = *color;
            }
        }

        Action::ReorderSpace { id, to } => {
            let from = data.spaces.iter().position(|space| &space.id == id)?;
            let to = (*to).clamp(0, data.spaces.len() as i64 - 1) as usize;
            if from == to {
                return None;
            }
            let moved = next.spaces.remove(from);
            next.spaces.insert(to, moved);
        }

        Action::DeleteSpace { id, blank_tab } => {
            // As on the desktop, a space goes with everything it kept. The personal space syncs, so it stays.
            let index = data.spaces.iter().position(|space| &space.id == id)?;
            if id == PERSONAL_SPACE_ID || data.spaces.len() < 2 {
                return None;
            }
            next.spaces.retain(|space| &space.id != id);
            // The space before it in the bar takes the screen, as the desktop's does.
            let active_space_id = if &data.active_space_id == id {
                next.spaces[index.saturating_sub(1)].id.clone()
            } else {
                data.active_space_id.clone()
            };
            next.tabs.retain(|tab| &tab.space_id != id);
            next.active_tab_ids.remove(id);
            let mut active_tab_id = if next.tabs.iter().any(|tab| tab.id == data.active_tab_id) {
                data.active_tab_id.clone()
            } else {
                next.active_tab_ids
                    .get(&active_space_id)
                    .cloned()
                    .unwrap_or_default()
            };
            if active_tab_id.is_empty() || !next.tabs.iter().any(|tab| tab.id == active_tab_id) {
                active_tab_id = next
                    .tabs
                    .iter()
                    .rev()
                    .find(|tab| tab.space_id == active_space_id)
                    .map(|tab| tab.id.clone())
                    .unwrap_or_default();
            }
            if active_tab_id.is_empty() {
                let mut blank = blank_tab.clone();
                blank.space_id = active_space_id.clone();
                active_tab_id = blank.id.clone();
                next.tabs.push(blank);
            }
            next.folders.retain(|folder| &folder.space_id != id);
            next.pinned_sites.retain(|site| &site.space_id != id);
            next.history.retain(|entry| &entry.space_id != id);
            next.bookmarks.remove(id);
            next.archive.retain(|tab| &tab.tab.space_id != id);
            next.active_tab_ids
                .insert(active_space_id.clone(), active_tab_id.clone());
            next.active_space_id = active_space_id;
            next.active_tab_id = active_tab_id;
        }

        Action::SelectSpace { id, blank_tab } => {
            if !has_space(data, id) {
                return None;
            }
            let in_space: Vec<&BrowserTab> =
                data.tabs.iter().filter(|tab| &tab.space_id == id).collect();
            let retained = data
                .active_tab_ids
                .get(id)
                .filter(|retained| in_space.iter().any(|tab| &&tab.id == retained));
            let active_tab_id = match retained.or_else(|| in_space.last().map(|tab| &tab.id)) {
                Some(tab_id) => tab_id.clone(),
                None => {
                    let blank = blank_tab.clone()?;
                    let tab_id = blank.id.clone();
                    next.tabs.push(blank);
                    tab_id
                }
            };
            next.active_space_id = id.clone();
            next.active_tab_ids
                .insert(id.clone(), active_tab_id.clone());
            next.active_tab_id = active_tab_id;
        }

        Action::NewFolder { folder } => {
            if !has_space(data, &folder.space_id) {
                return None;
            }
            next.folders.push(folder.clone());
        }

        Action::RenameFolder { id, name } => {
            let name = js::trim(name);
            if !data.folders.iter().any(|folder| &folder.id == id) || name.is_empty() {
                return None;
            }
            for folder in next.folders.iter_mut().filter(|folder| &folder.id == id) {
                folder.name = js::slice(name, NAME_LIMIT);
            }
        }

        Action::DeleteFolder { id } => {
            if !data.folders.iter().any(|folder| &folder.id == id) {
                return None;
            }
            next.folders.retain(|folder| &folder.id != id);
            for tab in next
                .tabs
                .iter_mut()
                .filter(|tab| tab.folder_id.as_ref() == Some(id))
            {
                tab.folder_id = None;
            }
            // Its pinned rows stay pinned, loose in the space.
            for site in next
                .pinned_sites
                .iter_mut()
                .filter(|site| site.folder_id.as_ref() == Some(id))
            {
                site.folder_id = None;
            }
        }

        Action::MoveTab {
            id,
            space_id,
            folder_id,
        } => {
            let tab = data.tabs.iter().find(|entry| &entry.id == id)?;
            if !has_space(data, space_id)
                || (&tab.space_id == space_id && &tab.folder_id == folder_id)
            {
                return None;
            }
            // The space left behind keeps its own current tab (nearest remaining in list order).
            if data.active_tab_ids.get(&tab.space_id) == Some(id) {
                match data
                    .tabs
                    .iter()
                    .rev()
                    .find(|entry| entry.space_id == tab.space_id && &entry.id != id)
                {
                    Some(left) => next
                        .active_tab_ids
                        .insert(tab.space_id.clone(), left.id.clone()),
                    None => next.active_tab_ids.remove(&tab.space_id),
                };
            }
            for entry in next.tabs.iter_mut().filter(|entry| &entry.id == id) {
                entry.space_id = space_id.clone();
                entry.folder_id = folder_id.clone();
            }
            // If the tab on screen moves, its space follows it.
            if &data.active_tab_id == id && space_id != &data.active_space_id {
                next.active_space_id = space_id.clone();
            }
        }

        Action::PinSite {
            tab_id,
            pin_id,
            kind,
            folder_id,
        } => {
            // Pins a tab's page in its space, or unpins it there when it is pinned already the same way.
            let tab = data
                .tabs
                .iter()
                .find(|entry| &entry.id == tab_id)
                .filter(|tab| !tab.url.is_empty())?;
            let folder_id = valid_pin_folder(data, *kind, folder_id.as_deref());
            let same = |site: &PinnedSite| site.space_id == tab.space_id && site.url == tab.url;
            let existing = data.pinned_sites.iter().find(|site| same(site));
            next.pinned_sites.retain(|site| !same(site));
            if existing.is_some_and(|site| site.kind == *kind && site.folder_id == folder_id) {
                return Some(next);
            }
            next.pinned_sites.push(PinnedSite {
                id: existing.map_or_else(|| pin_id.clone(), |site| site.id.clone()),
                url: tab.url.clone(),
                title: tab.title.clone(),
                favicon: tab.favicon.clone(),
                space_id: tab.space_id.clone(),
                kind: *kind,
                folder_id,
            });
        }

        Action::SyncSpacePins {
            space_id,
            pins,
            folders,
        } => {
            // The chain's pins for a space take the place of the phone's: they were made from the phone's last time round.
            if !has_space(data, space_id) {
                return None;
            }
            let mut favicons: HashMap<&str, Option<&String>> = HashMap::new();
            for site in &data.pinned_sites {
                favicons.insert(&site.url, site.favicon.as_ref());
            }
            let folders: Vec<BrowserFolder> = folders
                .iter()
                .map(|folder| BrowserFolder {
                    space_id: space_id.clone(),
                    ..folder.clone()
                })
                .collect();
            let folder_ids: HashSet<&str> =
                folders.iter().map(|folder| folder.id.as_str()).collect();
            let pins: Vec<PinnedSite> =
                pins.iter()
                    .map(|site| PinnedSite {
                        space_id: space_id.clone(),
                        favicon: site.favicon.clone().or_else(|| {
                            favicons.get(site.url.as_str()).copied().flatten().cloned()
                        }),
                        folder_id: site.folder_id.clone().filter(|folder| {
                            site.kind == PinKind::Row
                                && !folder.is_empty()
                                && folder_ids.contains(folder.as_str())
                        }),
                        ..site.clone()
                    })
                    .collect();
            next.pinned_sites.retain(|site| &site.space_id != space_id);
            next.pinned_sites.extend(pins);
            next.folders.retain(|folder| &folder.space_id != space_id);
            next.folders.extend(folders);
        }

        Action::SyncSpaces { added, changed } => {
            // Spaces the computer has come in; ones renamed or given an emoji there change here. The space showing stays.
            let known: HashSet<&str> = data.spaces.iter().map(|space| space.id.as_str()).collect();
            let changes: HashMap<&str, &SpaceChange> = changed
                .iter()
                .map(|change| (change.id.as_str(), change))
                .collect();
            let mut spaces: Vec<BrowserSpace> = data
                .spaces
                .iter()
                .map(|space| match changes.get(space.id.as_str()) {
                    Some(change) => {
                        let name = js::slice(js::trim(&change.name), NAME_LIMIT);
                        BrowserSpace {
                            id: space.id.clone(),
                            name: if name.is_empty() {
                                space.name.clone()
                            } else {
                                name
                            },
                            color: change.color,
                            icon: change
                                .icon
                                .as_deref()
                                .map(|icon| js::slice(icon, SPACE_ICON_LENGTH))
                                .filter(|icon| !icon.is_empty()),
                        }
                    }
                    None => space.clone(),
                })
                .collect();
            spaces.extend(
                added
                    .iter()
                    .filter(|space| !known.contains(space.id.as_str()))
                    .cloned(),
            );
            next.spaces = with_space_emoji(spaces);
        }

        Action::MovePin {
            id,
            kind,
            folder_id,
            beside,
            after,
        } => {
            let folder_id = valid_pin_folder(data, *kind, folder_id.as_deref());
            let at = next.pinned_sites.iter().position(|site| &site.id == id)?;
            let mut site = next.pinned_sites.remove(at);
            site.kind = *kind;
            site.folder_id = folder_id;
            let place = beside
                .as_ref()
                .filter(|beside| *beside != id)
                .and_then(|beside| next.pinned_sites.iter().position(|site| &site.id == beside))
                .map_or(at, |place| place + usize::from(*after));
            next.pinned_sites.insert(place, site);
        }

        Action::RemovePin { id } => next.pinned_sites.retain(|site| &site.id != id),

        Action::AddPin { site, index } => {
            if data
                .pinned_sites
                .iter()
                .any(|entry| entry.space_id == site.space_id && entry.url == site.url)
            {
                return None;
            }
            next.pinned_sites
                .insert(splice_index(*index, data.pinned_sites.len()), site.clone());
        }

        Action::RemoveHistory { space_id, url } => next
            .history
            .retain(|entry| !(&entry.space_id == space_id && &entry.url == url)),

        Action::RemoveArchived { id } => {
            if !data.archive.iter().any(|tab| &tab.tab.id == id) {
                return None;
            }
            next.archive.retain(|tab| &tab.tab.id != id);
        }

        Action::ClearArchive { space_id } => {
            match space_id {
                Some(space_id) => next.archive.retain(|tab| &tab.tab.space_id != space_id),
                None => next.archive.clear(),
            }
            if next.archive.len() == data.archive.len() {
                return None;
            }
        }

        Action::Wallpaper { id, photo } => {
            // A new photo replaces the old one; picking a built-in keeps the photo for switching back.
            let current = &data.preferences.wallpaper_photo;
            let photo = if *id == WallpaperId::Photo {
                photo.clone().or_else(|| current.clone())
            } else {
                current.clone()
            };
            if *id == WallpaperId::Photo && !photo.as_deref().is_some_and(js::is_file_uri) {
                return None;
            }
            if *id == data.preferences.wallpaper && &photo == current {
                return None;
            }
            next.preferences.wallpaper = *id;
            next.preferences.wallpaper_photo = photo;
        }

        Action::ClearHistory { space_id } => {
            match space_id {
                Some(space_id) => next.history.retain(|entry| &entry.space_id != space_id),
                None => next.history.clear(),
            }
            if next.history.len() == data.history.len() {
                return None;
            }
            // Icons stay for sites a tab, the archive, a pin or another space's history still shows.
            let shown: HashSet<String> = data
                .tabs
                .iter()
                .map(|tab| &tab.url)
                .chain(data.archive.iter().map(|tab| &tab.tab.url))
                .chain(data.pinned_sites.iter().map(|site| &site.url))
                .chain(next.history.iter().map(|entry| &entry.url))
                .map(|url| js::site_host(url))
                .collect();
            next.favicons.retain(|host, _| shown.contains(host));
        }

        Action::Favicon { host, uri } => {
            if data.favicons.get(host) == uri.as_ref() {
                return None;
            }
            next.favicons.shift_remove(host);
            if let Some(uri) = uri {
                // Oldest first, so the cap drops the icons fetched longest ago.
                next.favicons.insert(host.clone(), uri.clone());
                let excess = next.favicons.len().saturating_sub(FAVICON_LIMIT);
                next.favicons.drain(..excess);
            }
        }

        Action::SearchEngine { id, custom_url } => {
            if id.is_empty() {
                return None;
            }
            match custom_url {
                Some(custom_url) => {
                    let custom_url = js::trim(custom_url);
                    if !js::is_custom_search_url(custom_url) {
                        return None;
                    }
                    next.preferences.search_engine_id = id.clone();
                    next.preferences.custom_search_url = Some(custom_url.to_owned());
                }
                None => {
                    if id == &data.preferences.search_engine_id {
                        return None;
                    }
                    next.preferences.search_engine_id = id.clone();
                }
            }
        }

        Action::ArchiveDays { days } => {
            let allowed = [None, Some(0.5), Some(1.0), Some(7.0), Some(30.0)];
            if !allowed.contains(days) || *days == data.preferences.archive_after_days {
                return None;
            }
            next.preferences.archive_after_days = *days;
        }

        Action::BlockContent { enabled } => {
            if *enabled == data.preferences.block_content {
                return None;
            }
            next.preferences.block_content = *enabled;
        }

        Action::TipSeen { id } => {
            if data.preferences.tips_seen.contains(id) {
                return None;
            }
            next.preferences.tips_seen.push(*id);
        }

        Action::WelcomeAgain => {
            next.preferences.welcomed = false;
            next.preferences.tips_seen.clear();
        }

        Action::PauseBlocking { host, paused } => {
            let lower = host.to_lowercase();
            let host = lower.strip_prefix("www.").unwrap_or(&lower);
            let hosts = &mut next.preferences.blocking_paused_hosts;
            if host.is_empty() || hosts.iter().any(|entry| entry == host) == *paused {
                return None;
            }
            if *paused {
                hosts.push(host.to_owned());
            } else {
                hosts.retain(|entry| entry != host);
            }
        }

        Action::LockPrivateTabs { enabled } => {
            if *enabled == data.preferences.lock_private_tabs {
                return None;
            }
            next.preferences.lock_private_tabs = *enabled;
        }

        Action::Left { now } => next.left_at = Some(*now),

        Action::Preferences { update } => {
            // Only the updated keys come from the parse, so untouched preferences stay as they are.
            let mut merged = preferences_json(&data.preferences);
            let serde_json::Value::Object(changes) =
                serde_json::to_value(update).unwrap_or_default()
            else {
                return None;
            };
            merged.extend(changes.clone());
            let parsed = preferences_json(&parse_preferences(&merged));
            let current = preferences_json(&data.preferences);
            if changes
                .keys()
                .all(|key| parsed.get(key) == current.get(key))
            {
                return None;
            }
            let mut updated = current;
            for key in changes.keys() {
                if let Some(value) = parsed.get(key) {
                    updated.insert(key.clone(), value.clone());
                }
            }
            next.preferences = serde_json::from_value(serde_json::Value::Object(updated)).ok()?;
        }

        Action::ReaderSettingsChange { settings } => {
            let reader = parse_reader_settings(
                &serde_json::to_value(settings).unwrap_or_default(),
                data.preferences.reader,
            );
            if reader == data.preferences.reader {
                return None;
            }
            next.preferences.reader = reader;
        }

        Action::HiddenElements { host, selectors } => {
            let host = js::normalize_host(host)?;
            let selectors = parse_selectors(&serde_json::to_value(selectors).unwrap_or_default());
            let previous = data
                .preferences
                .hidden_elements
                .get(&host)
                .cloned()
                .unwrap_or_default();
            if selectors == previous {
                return None;
            }
            if selectors.is_empty() {
                next.preferences.hidden_elements.remove(&host);
            } else {
                next.preferences.hidden_elements.insert(host, selectors);
            }
        }

        Action::SiteSettings { host, update } => {
            let host = js::normalize_host(host)?;
            let setting = parse_site_setting_input(update);
            if data.preferences.site_settings.get(&host) == Some(&setting) {
                return None;
            }
            // An entry with nothing of its own left adds nothing; the site follows the globals again.
            if setting.is_default() {
                next.preferences.site_settings.remove(&host);
            } else {
                next.preferences.site_settings.insert(host, setting);
            }
        }

        Action::Download { update, now } => {
            let previous = data.downloads.iter().find(|item| item.id == update.id);
            // The engine says nothing more after a final state; a late progress update can't revive it.
            if previous.is_some_and(|item| item.state != DownloadState::Downloading) {
                return None;
            }
            let state = match update.state {
                DownloadEventState::Started | DownloadEventState::Progress => {
                    DownloadState::Downloading
                }
                DownloadEventState::Finished => DownloadState::Finished,
                DownloadEventState::Failed => DownloadState::Failed,
                DownloadEventState::Cancelled => DownloadState::Cancelled,
            };
            let non_empty =
                |value: &Option<String>| value.clone().filter(|value| !value.is_empty());
            let item = DownloadItem {
                id: update.id.clone(),
                url: if update.url.is_empty() {
                    previous.map(|item| item.url.clone()).unwrap_or_default()
                } else {
                    update.url.clone()
                },
                // The engine knows the real name once the response arrives; a cancelled update may not.
                filename: if !update.filename.is_empty() && update.filename != "download" {
                    update.filename.clone()
                } else {
                    previous.map_or_else(|| update.filename.clone(), |item| item.filename.clone())
                },
                state,
                received: update.received,
                total: if update.total != 0 {
                    update.total
                } else {
                    previous.map_or(0, |item| item.total)
                },
                path: non_empty(&update.path)
                    .or_else(|| previous.and_then(|item| item.path.clone())),
                error: non_empty(&update.error),
                waiting: non_empty(&update.waiting).filter(|_| state == DownloadState::Downloading),
                started_at: previous.map_or(*now, |item| item.started_at),
                private: update.private,
            };
            // Engines repeat unchanged progress; keep the same state so nothing re-renders.
            if previous == Some(&item) {
                return None;
            }
            match next
                .downloads
                .iter_mut()
                .find(|entry| entry.id == update.id)
            {
                Some(entry) => *entry = item,
                None => next.downloads.insert(0, item),
            }
            next.downloads.truncate(DOWNLOAD_LIMIT);
        }

        Action::RemoveDownload { id } => {
            if !data.downloads.iter().any(|item| &item.id == id) {
                return None;
            }
            next.downloads.retain(|item| &item.id != id);
        }

        Action::ClearDownloads => {
            // Downloads still running stay listed.
            next.downloads
                .retain(|item| item.state == DownloadState::Downloading);
            if next.downloads.len() == data.downloads.len() {
                return None;
            }
        }

        Action::ArchiveStale { now } => {
            let days = data.preferences.archive_after_days?;
            let cutoff = *now as f64 - days * DAY;
            let pinned: HashSet<&str> = data
                .pinned_sites
                .iter()
                .map(|pin| pin.url.as_str())
                .collect();
            let stale: Vec<BrowserTab> = data
                .tabs
                .iter()
                .filter(|tab| {
                    !tab.private
                        && tab.id != data.active_tab_id
                        && !tab.url.is_empty()
                        && (tab.last_visit as f64) < cutoff
                        && !pinned.contains(tab.url.as_str())
                })
                .cloned()
                .collect();
            if stale.is_empty() {
                return None;
            }
            let ids: HashSet<&str> = stale.iter().map(|tab| tab.id.as_str()).collect();
            next.active_tab_ids
                .retain(|space_id, tab_id| !ids.contains(tab_id.as_str()) && !space_id.is_empty());
            next.tabs.retain(|tab| !ids.contains(tab.id.as_str()));
            next.archive = archive_tabs(&data.archive, &stale, *now);
        }
    }
    Some(next)
}

/// A pinned row's folder, when it names one the state has; Essentials have none.
fn valid_pin_folder(data: &BrowserData, kind: PinKind, folder_id: Option<&str>) -> Option<String> {
    folder_id
        .filter(|folder| {
            kind == PinKind::Row
                && !folder.is_empty()
                && data.folders.iter().any(|entry| &entry.id == folder)
        })
        .map(str::to_owned)
}

/// Where `Array.prototype.splice(index, 0, item)` puts an item: negative indexes count from the end.
fn splice_index(index: i64, len: usize) -> usize {
    let len = len as i64;
    (if index < 0 {
        (len + index).max(0)
    } else {
        index.min(len)
    }) as usize
}
