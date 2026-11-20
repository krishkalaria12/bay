//! Settings without the screen: its pages, the index's cards, each page's sections of rows and the search that finds a
//! page or a row by what it says. Ported from the Expo app's `src/settings/model.ts` and `content.ts` (after Yab's
//! Settings, Apache-2.0). Where the TypeScript rows held callbacks, these hold a [`SettingsAction`] the app performs, so
//! the whole tree is plain data both apps draw. Checked against `fixtures/settings.jsonl`
//! (`scripts/settings-vector.mjs`), recorded from the TypeScript pages with spies for every callback.

mod content;
mod search;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use content::synced_ago;
pub use content::{CUSTOM_ENGINE_ID, index_value, page_tile, search_entries, sections};
pub use search::{match_settings, path_to, words};

use crate::i18n::{catalog, format_message};
use crate::store::BrowserPreferences;
use crate::store::model::PreferencesUpdate;
use crate::sync::service::{SyncType, SyncView};

/// The pages Settings can show. The first nine are on the index; the rest open from a row on another page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "camelCase")]
pub enum SettingsPage {
    General,
    Search,
    Appearance,
    Tabs,
    Sync,
    Privacy,
    Passwords,
    Youtube,
    About,
    DefaultBrowser,
    Language,
    Swipe,
    AppLinks,
    CustomEngine,
    Wallpaper,
    AppIcon,
    TextSize,
    SiteFont,
    Archive,
    StartPage,
    SyncJoin,
    SyncPhrase,
}

pub const SETTINGS_PAGES: [SettingsPage; 22] = [
    SettingsPage::General,
    SettingsPage::Search,
    SettingsPage::Appearance,
    SettingsPage::Tabs,
    SettingsPage::Sync,
    SettingsPage::Privacy,
    SettingsPage::Passwords,
    SettingsPage::Youtube,
    SettingsPage::About,
    SettingsPage::DefaultBrowser,
    SettingsPage::Language,
    SettingsPage::Swipe,
    SettingsPage::AppLinks,
    SettingsPage::CustomEngine,
    SettingsPage::Wallpaper,
    SettingsPage::AppIcon,
    SettingsPage::TextSize,
    SettingsPage::SiteFont,
    SettingsPage::Archive,
    SettingsPage::StartPage,
    SettingsPage::SyncJoin,
    SettingsPage::SyncPhrase,
];

impl SettingsPage {
    /// The page's name, as ids and test ids spell it.
    pub fn name(self) -> &'static str {
        match self {
            Self::General => "general",
            Self::Search => "search",
            Self::Appearance => "appearance",
            Self::Tabs => "tabs",
            Self::Sync => "sync",
            Self::Privacy => "privacy",
            Self::Passwords => "passwords",
            Self::Youtube => "youtube",
            Self::About => "about",
            Self::DefaultBrowser => "defaultBrowser",
            Self::Language => "language",
            Self::Swipe => "swipe",
            Self::AppLinks => "appLinks",
            Self::CustomEngine => "customEngine",
            Self::Wallpaper => "wallpaper",
            Self::AppIcon => "appIcon",
            Self::TextSize => "textSize",
            Self::SiteFont => "siteFont",
            Self::Archive => "archive",
            Self::StartPage => "startPage",
            Self::SyncJoin => "syncJoin",
            Self::SyncPhrase => "syncPhrase",
        }
    }

    /// Where ‹ goes from the page: the page that opened it, or the index.
    pub fn parent(self) -> Option<Self> {
        match self {
            Self::DefaultBrowser | Self::Language | Self::Swipe | Self::AppLinks => {
                Some(Self::General)
            }
            Self::CustomEngine => Some(Self::Search),
            Self::Wallpaper | Self::AppIcon | Self::TextSize | Self::SiteFont => {
                Some(Self::Appearance)
            }
            Self::Archive | Self::StartPage => Some(Self::Tabs),
            Self::SyncJoin | Self::SyncPhrase => Some(Self::Sync),
            _ => None,
        }
    }

    /// Pages that draw their own body below their sections: a field, the wallpapers, the app icons, the zoom's preview.
    pub fn is_drawn(self) -> bool {
        matches!(
            self,
            Self::CustomEngine
                | Self::Wallpaper
                | Self::AppIcon
                | Self::TextSize
                | Self::SyncJoin
                | Self::SyncPhrase
        )
    }
}

/// Something the index opens that isn't a page of Settings: one of the browser's own sheets, or an action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum IndexAction {
    Bookmarks,
    History,
    Downloads,
    Import,
    Report,
}

impl IndexAction {
    pub fn name(self) -> &'static str {
        match self {
            Self::Bookmarks => "bookmarks",
            Self::History => "history",
            Self::Downloads => "downloads",
            Self::Import => "import",
            Self::Report => "report",
        }
    }
}

/// A row of the index.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum IndexEntry {
    Page { page: SettingsPage },
    Action { action: IndexAction },
}

impl IndexEntry {
    /// The entry's id, for test ids and the search's results: the page's or the action's name.
    pub fn id(self) -> &'static str {
        match self {
            Self::Page { page } => page.name(),
            Self::Action { action } => action.name(),
        }
    }
}

const fn page(page: SettingsPage) -> IndexEntry {
    IndexEntry::Page { page }
}

const fn action(action: IndexAction) -> IndexEntry {
    IndexEntry::Action { action }
}

/// The index's cards, as Yab groups its own: the basic pages, what Bay keeps and guards, your things, then Bay itself.
pub const INDEX: [&[IndexEntry]; 4] = [
    &[
        page(SettingsPage::General),
        page(SettingsPage::Search),
        page(SettingsPage::Appearance),
        page(SettingsPage::Tabs),
        page(SettingsPage::Sync),
    ],
    &[
        page(SettingsPage::Privacy),
        page(SettingsPage::Passwords),
        page(SettingsPage::Youtube),
    ],
    &[
        action(IndexAction::Bookmarks),
        action(IndexAction::History),
        action(IndexAction::Downloads),
        action(IndexAction::Import),
    ],
    &[page(SettingsPage::About), action(IndexAction::Report)],
];

/// What a row asks the app to do when tapped: what the TypeScript rows' callbacks did.
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum SettingsAction {
    /// Change these preferences in the store.
    Change {
        update: PreferencesUpdate,
    },
    ChooseEngine {
        id: String,
    },
    SetArchiveAfterDays {
        days: Option<f64>,
    },
    SetBlockContent {
        on: bool,
    },
    ResumeBlocking {
        host: String,
    },
    SetLockPrivateTabs {
        on: bool,
    },
    /// None follows the phone's language again.
    SetLanguage {
        locale: Option<String>,
    },
    MakeDefault,
    ExportTabs,
    ForgetLogin {
        login: LoginSummary,
    },
    /// Clearing all browsing data: ask, go ahead, or keep it.
    AskToClear,
    ConfirmClear,
    KeepData,
    ShowWelcome,
    OpenLink {
        url: String,
    },
    SyncNow,
    SetSyncType {
        kind: SyncType,
        on: bool,
    },
    LeaveSync,
    /// Opens another device's tab here.
    OpenSyncedTab {
        url: String,
    },
}

/// What a row does when tapped.
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum RowKind {
    /// Opens its page (a chevron); `checked` adds a tick, for a choice that has a page of its own.
    Page { page: SettingsPage, checked: bool },
    /// One of a page's choices (a tick when chosen).
    Choice {
        selected: bool,
        action: SettingsAction,
    },
    /// A switch, and what turning it on or off does.
    Toggle {
        on: bool,
        when_on: SettingsAction,
        when_off: SettingsAction,
    },
    /// Does something now: no chevron.
    Action { action: SettingsAction },
    /// Says something; no tap.
    Info,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SettingsRow {
    /// Unique on its page: the search's target, and what the page scrolls to.
    pub id: String,
    pub test_id: String,
    pub label: String,
    /// A second line under the label.
    pub detail: Option<String>,
    /// The current setting, at the right.
    pub value: Option<String>,
    /// The glyph in its grey square before the label; "mark" is Bay's own icon.
    pub icon: Option<String>,
    pub kind: RowKind,
    /// The label in red: an action that ends something.
    pub danger: bool,
    pub disabled: bool,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SettingsSection {
    pub id: String,
    pub title: Option<String>,
    pub rows: Vec<SettingsRow>,
    /// What the rows above mean, in small print under the group.
    pub footer: Option<String>,
    /// The footer's test id, where a test reads it.
    pub footer_test_id: Option<String>,
}

/// A page's tile: a glyph on a colour, or Bay's own icon (`mark`, no tint).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SettingsTile {
    pub icon: String,
    pub tint: Option<String>,
}

/// A saved sign-in, as the Passwords page lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct LoginSummary {
    pub origin: String,
    pub username: String,
}

/// Where clearing all browsing data is: not asked, asked, running, or failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum ClearStage {
    Idle,
    Confirming,
    Busy,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum SettingsPlatform {
    Ios,
    Android,
}

/// Whether Bay is the default browser, as far as the phone says.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum DefaultBrowser {
    Default,
    Not,
    Unknown,
    Unavailable,
}

/// The language Bay was told to use (none follows the phone), the one it uses, and the phone's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct LanguageState {
    pub saved: Option<String>,
    pub current: String,
    pub device: String,
}

/// A search engine as Settings › Search lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct EngineChoice {
    pub id: String,
    pub name: String,
}

/// Everything Settings shows: the store's preferences and what only the app knows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct SettingsContext {
    /// The language the pages are written in.
    pub locale: String,
    pub platform: SettingsPlatform,
    pub version: String,
    pub prefs: BrowserPreferences,
    pub engines: Vec<EngineChoice>,
    /// What the blocker says it is using ("8 lists active").
    pub blocker_detail: String,
    /// The wallpaper's name, said on its row.
    pub wallpaper_name: String,
    /// The home screen icon's name, said on its row; none where the phone can't change it.
    pub app_icon_name: Option<String>,
    pub language: LanguageState,
    pub default_browser: DefaultBrowser,
    pub open_tab_count: u32,
    /// The saved sign-ins; none while they load.
    pub logins: Option<Vec<LoginSummary>>,
    pub clear_stage: ClearStage,
    pub sync: SyncView,
    /// Now, for "Synced 5 min ago".
    pub now: i64,
}

/// What the index says under an entry's name needs these counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct IndexCounts {
    pub bookmarks: u32,
    pub history: u32,
    pub downloads: u32,
    pub crashes: u32,
}

/// A row of the index as drawn: its tile, name and what it is set to.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct IndexRow {
    pub entry: IndexEntry,
    pub id: String,
    pub title: String,
    pub value: Option<String>,
    pub tile: SettingsTile,
}

/// A page as drawn: its header (tile, name, one line), its sections, and whether it draws a body of its own.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SettingsPageView {
    pub page: SettingsPage,
    pub title: String,
    pub blurb: Option<String>,
    pub tile: Option<SettingsTile>,
    pub sections: Vec<SettingsSection>,
    pub drawn: bool,
    pub parent: Option<SettingsPage>,
}

/// An index entry as the search reads it: its name, the words it's known by, and its rows (none for an action).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchEntry {
    pub entry: IndexEntry,
    pub title: String,
    pub keywords: String,
    pub rows: Vec<SearchRow>,
}

/// A row as the search reads it: `page` names the page it's on when that is one further in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchRow {
    pub id: String,
    pub label: String,
    pub detail: Option<String>,
    pub value: Option<String>,
    pub page: Option<SettingsPage>,
}

/// What the search found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct SettingsMatch {
    pub entry: IndexEntry,
    /// The row that matched, to scroll to; none when the name or its words did.
    pub row: Option<String>,
    /// The page the row is on, when it isn't the entry's own (a choice one page further in).
    pub page: Option<SettingsPage>,
    /// What the result says under the name: the row that matched.
    pub detail: Option<String>,
    pub id: String,
}

/// The words of one language, English behind them, as the app's `t` looks them up.
pub(crate) struct Words(HashMap<String, String>);

impl Words {
    pub(crate) fn new(locale: &str) -> Self {
        Self(catalog(locale.to_owned()))
    }

    pub(crate) fn t(&self, key: &str) -> String {
        self.0.get(key).cloned().unwrap_or_else(|| key.to_owned())
    }

    pub(crate) fn with(&self, key: &str, params: &[(&str, String)]) -> String {
        format_message(
            self.t(key),
            params
                .iter()
                .map(|(name, value)| ((*name).to_owned(), value.clone()))
                .collect(),
        )
    }
}

/// The index's cards, each entry with its tile, name and what it is set to.
#[uniffi::export]
pub fn settings_index(ctx: SettingsContext, counts: IndexCounts) -> Vec<Vec<IndexRow>> {
    let words = Words::new(&ctx.locale);
    INDEX
        .iter()
        .map(|card| {
            card.iter()
                .map(|entry| {
                    let info = content::entry_info(*entry);
                    IndexRow {
                        entry: *entry,
                        id: entry.id().to_owned(),
                        title: words.t(info.title),
                        value: content::index_value_in(*entry, &ctx, counts, &words),
                        tile: info.tile(),
                    }
                })
                .collect()
        })
        .collect()
}

/// A page: its header and sections.
#[uniffi::export]
pub fn settings_page(page: SettingsPage, ctx: SettingsContext) -> SettingsPageView {
    let words = Words::new(&ctx.locale);
    SettingsPageView {
        page,
        title: words.t(content::page_title(page)),
        blurb: content::page_blurb(page).map(|key| words.t(key)),
        tile: page_tile(page),
        sections: content::sections_in(page, &ctx, &words),
        drawn: page.is_drawn(),
        parent: page.parent(),
    }
}

/// What a query finds on the index and its pages.
#[uniffi::export]
pub fn settings_search(query: &str, ctx: SettingsContext) -> Vec<SettingsMatch> {
    match_settings(query, &search_entries(&ctx))
}

/// The pages to open for a page: its parents first, so ‹ goes where it would have.
#[uniffi::export]
pub fn settings_path(page: SettingsPage) -> Vec<SettingsPage> {
    path_to(page)
}

/// "Synced 5 min ago", and the like, in `locale`.
#[uniffi::export]
pub fn synced_ago_text(at: i64, now: i64, locale: &str) -> String {
    synced_ago(at, now, &Words::new(locale))
}
