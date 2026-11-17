//! The browser's state, as the Expo app's `src/store/types.ts` shapes it: the same fields under the same JSON names,
//! so the document it saved (`browser.json`, version 2) reads and writes unchanged.

use std::collections::{BTreeMap, HashMap};

use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize};

fn is_false(value: &bool) -> bool {
    !*value
}

/// Reads a field that may be absent (`None`), null (`Some(None)`) or set (`Some(Some(_))`).
pub(crate) fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum SpaceColor {
    Gray,
    Blue,
    Green,
    Orange,
    Red,
    Violet,
}

/// Bay's space colours, in the editor's order.
pub const SPACE_COLORS: [SpaceColor; 6] = [
    SpaceColor::Blue,
    SpaceColor::Green,
    SpaceColor::Orange,
    SpaceColor::Red,
    SpaceColor::Violet,
    SpaceColor::Gray,
];

/// One named slice of the browser, as the desktop's spaces: its own tabs, pins, history, bookmarks and site data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct BrowserSpace {
    pub id: String,
    pub name: String,
    pub color: SpaceColor,
    /// An emoji. Every space wears one once the state is read; one saved without gets a free one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

/// A named group of tabs and pinned rows inside a space.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFolder {
    pub id: String,
    pub space_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    pub id: String,
    pub url: String,
    pub title: String,
    pub favicon: Option<String>,
    pub created_at: i64,
    pub last_visit: i64,
    pub snapshot: Option<String>,
    /// Private tabs are never saved, archived or added to history.
    #[serde(default, skip_serializing_if = "is_false")]
    pub private: bool,
    pub space_id: String,
    /// A folder inside the space; none at the space's top level.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// The space whose history this is: each space keeps its own.
    pub space_id: String,
    pub url: String,
    pub title: String,
    pub favicon: Option<String>,
    pub visits: i64,
    pub last_visit: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum PinKind {
    /// A tile above the space's tabs and on the start page.
    Essential,
    /// A row in the space's Pinned section, loose or in a folder.
    Row,
}

/// A pinned page in a space, as the desktop keeps them. It syncs as the desktop's pin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct PinnedSite {
    pub id: String,
    pub url: String,
    pub title: String,
    pub favicon: Option<String>,
    pub space_id: String,
    pub kind: PinKind,
    /// A pinned row's folder; Essentials have none.
    pub folder_id: Option<String>,
}

/// A bookmark or a folder of them. A space's tree hangs off its root folder, `BOOKMARKS_ROOT`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum BookmarkNode {
    Url {
        id: String,
        parent_id: String,
        title: String,
        url: String,
        added_at: i64,
    },
    Folder {
        id: String,
        parent_id: Option<String>,
        title: String,
        children: Vec<String>,
        added_at: i64,
    },
}

impl BookmarkNode {
    pub fn id(&self) -> &str {
        match self {
            Self::Url { id, .. } | Self::Folder { id, .. } => id,
        }
    }

    pub fn parent_id(&self) -> Option<&str> {
        match self {
            Self::Url { parent_id, .. } => Some(parent_id),
            Self::Folder { parent_id, .. } => parent_id.as_deref(),
        }
    }
}

/// Every bookmark and folder of a tree, by id.
pub type Bookmarks = HashMap<String, BookmarkNode>;

/// A closed tab, kept for the archive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedTab {
    #[serde(flatten)]
    pub tab: BrowserTab,
    pub closed_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum DownloadState {
    Downloading,
    Finished,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct DownloadItem {
    /// The engine's id: a UUID on iOS, the system download id on Android.
    pub id: String,
    pub url: String,
    pub filename: String,
    pub state: DownloadState,
    pub received: i64,
    /// 0 when the size isn't known.
    pub total: i64,
    /// The saved file, once finished.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Why it isn't moving yet ("Starting…", "Waiting for Wi-Fi"); absent while bytes arrive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting: Option<String>,
    pub started_at: i64,
    /// From a private tab: kept in memory only.
    #[serde(default, skip_serializing_if = "is_false")]
    pub private: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum ReaderTheme {
    Light,
    Paper,
    Sepia,
    Mint,
    Gray,
    Dark,
    Black,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum ReaderFont {
    Serif,
    Sans,
    Mono,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct ReaderSettings {
    pub theme: ReaderTheme,
    pub font: ReaderFont,
    /// Body text size in CSS pixels, 14–28.
    pub size: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum SwipeMode {
    Anywhere,
    Edges,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum AppLinks {
    App,
    Browser,
}

/// A first-run tip: the bar's gestures, and what blocking did on the first page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum TipId {
    Bar,
    Blocking,
}

/// The first-run tips, in the order they may show.
pub const TIP_IDS: [TipId; 2] = [TipId::Blocking, TipId::Bar];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum ThemeChoice {
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum WallpaperId {
    Bay,
    Dusk,
    Forest,
    Plain,
    Photo,
}

/// A kind of blocking a site can turn off on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum SiteBlockGroup {
    Ads,
    Trackers,
    Cookies,
}

/// The kinds of blocking a site turns off, in Site Settings' order.
pub const SITE_BLOCK_GROUPS: [SiteBlockGroup; 3] = [
    SiteBlockGroup::Ads,
    SiteBlockGroup::Trackers,
    SiteBlockGroup::Cookies,
];

/// What one site keeps instead of the global settings. A host without an entry keeps every global choice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct SiteSetting {
    /// Page zoom in percent (80–200), or none for the global zoom.
    pub text_size: Option<i64>,
    /// Reader opens by itself as each article here finishes loading.
    pub reader: bool,
    /// The site answers with its desktop page.
    pub desktop_mode: bool,
    /// What isn't blocked on this site. Empty blocks all three.
    pub block_off: Vec<SiteBlockGroup>,
    /// Swipe to navigate on this site, or none for Bay's own choice.
    pub swipe: Option<SwipeMode>,
}

impl SiteSetting {
    pub const EMPTY: Self = Self {
        text_size: None,
        reader: false,
        desktop_mode: false,
        block_off: Vec::new(),
        swipe: None,
    };

    pub fn is_default(&self) -> bool {
        self.text_size.is_none()
            && !self.reader
            && !self.desktop_mode
            && self.block_off.is_empty()
            && self.swipe.is_none()
    }
}

/// What to hide on YouTube, with Brave's lists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, uniffi::Record)]
pub struct YouTubeCleanup {
    pub shorts: bool,
    pub suggestions: bool,
    pub distractions: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPreferences {
    pub search_engine_id: String,
    pub archive_after_days: Option<f64>,
    /// Block ads and trackers with the filter lists.
    pub block_content: bool,
    /// Sites (hosts) where blocking is paused.
    pub blocking_paused_hosts: Vec<String>,
    /// Ask for Face ID, Touch ID or the device passcode before showing private tabs again.
    pub lock_private_tabs: bool,
    pub reader: ReaderSettings,
    /// Element selectors hidden on each host.
    pub hidden_elements: HashMap<String, Vec<String>>,
    /// Overrides kept per site (host without www.).
    pub site_settings: HashMap<String, SiteSetting>,
    pub wallpaper: WallpaperId,
    /// The user's photo, copied into the app's documents (a file:// URI).
    pub wallpaper_photo: Option<String>,
    pub theme: ThemeChoice,
    /// Page zoom in percent (80–200).
    pub text_size: i64,
    pub search_suggestions: bool,
    pub skip_amp: bool,
    pub pull_to_refresh: bool,
    /// Show the start page when Bay comes back after this many hours away; none stays on the last tab.
    pub start_page_after_hours: Option<i64>,
    pub youtube: YouTubeCleanup,
    /// The welcome has been seen (or skipped).
    pub welcomed: bool,
    /// Bay opens ready to type.
    pub open_search_on_launch: bool,
    /// The custom search engine's address, used while `search_engine_id` is "custom".
    pub custom_search_url: Option<String>,
    pub tips_seen: Vec<TipId>,
    pub swipe_to_navigate: SwipeMode,
    pub app_links: AppLinks,
}

impl Default for BrowserPreferences {
    fn default() -> Self {
        Self {
            search_engine_id: "google".into(),
            archive_after_days: Some(7.0),
            block_content: true,
            blocking_paused_hosts: Vec::new(),
            lock_private_tabs: false,
            reader: ReaderSettings {
                theme: ReaderTheme::Paper,
                font: ReaderFont::Serif,
                size: 19,
            },
            hidden_elements: HashMap::new(),
            site_settings: HashMap::new(),
            wallpaper: WallpaperId::Bay,
            wallpaper_photo: None,
            theme: ThemeChoice::System,
            text_size: 100,
            search_suggestions: true,
            skip_amp: true,
            pull_to_refresh: true,
            start_page_after_hours: None,
            youtube: YouTubeCleanup::default(),
            welcomed: false,
            open_search_on_launch: false,
            custom_search_url: None,
            tips_seen: Vec::new(),
            swipe_to_navigate: SwipeMode::Anywhere,
            app_links: AppLinks::App,
        }
    }
}

/// The whole browsing state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserData {
    pub tabs: Vec<BrowserTab>,
    pub spaces: Vec<BrowserSpace>,
    pub active_space_id: String,
    /// The tab last active in each space; a space reopens where it was left.
    pub active_tab_ids: BTreeMap<String, String>,
    pub folders: Vec<BrowserFolder>,
    pub active_tab_id: String,
    pub history: Vec<HistoryEntry>,
    pub pinned_sites: Vec<PinnedSite>,
    /// Each space's own bookmark tree, by space id.
    pub bookmarks: BTreeMap<String, Bookmarks>,
    pub archive: Vec<ArchivedTab>,
    /// Newest first.
    pub downloads: Vec<DownloadItem>,
    pub preferences: BrowserPreferences,
    /// Each site's icon (host without www.), oldest first: a file:// URI.
    pub favicons: IndexMap<String, String>,
    /// When Bay last went to the background.
    pub left_at: Option<i64>,
}

/// The tab fields an engine update can change. An absent field stays; `Some(None)` clears a nullable one.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct TabUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub favicon: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_visit: Option<i64>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub snapshot: Option<Option<String>>,
}
