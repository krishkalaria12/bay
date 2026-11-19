//! What each page of Settings says: its name, its line, the words it's found by, its tile on the index, and its sections
//! of rows. The Expo app's `src/settings/content.ts`, row for row.

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

use super::{
    ClearStage, DefaultBrowser, INDEX, IndexAction, IndexCounts, IndexEntry, LoginSummary, RowKind,
    SearchEntry, SearchRow, SettingsAction, SettingsContext, SettingsPage, SettingsPlatform,
    SettingsRow, SettingsSection, SettingsTile, Words,
};
use crate::i18n::locale_name;
use crate::js::number_string;
use crate::store::model::{PreferencesUpdate, START_PAGE_HOURS};
use crate::store::{AppLinks, SwipeMode, ThemeChoice, YouTubeCleanup};
use crate::sync::service::{SyncStatus, SyncType};

/// The colours of the index's tiles, white glyphs on them, one per kind of page (as iOS Settings has them).
mod tint {
    pub const GREY: &str = "#8E8E93";
    pub const BLUE: &str = "#3478F6";
    pub const PINK: &str = "#D9488F";
    pub const ORANGE: &str = "#F08C2E";
    pub const INDIGO: &str = "#5E5CE6";
    pub const RED: &str = "#E5484D";
    pub const AMBER: &str = "#F29A1F";
    pub const PURPLE: &str = "#8B5CF6";
    pub const GREEN: &str = "#34A853";
}

/// The custom search engine's id, chosen from its own page.
pub const CUSTOM_ENGINE_ID: &str = "custom";

pub const SOURCE_URL: &str = "https://github.com/krishkalaria12/bay";
pub const ISSUES_URL: &str = "https://github.com/krishkalaria12/bay/issues";

pub(super) struct EntryInfo {
    pub title: &'static str,
    pub keywords: &'static str,
    icon: &'static str,
    tint: Option<&'static str>,
}

impl EntryInfo {
    pub fn tile(&self) -> SettingsTile {
        SettingsTile {
            icon: self.icon.into(),
            tint: self.tint.map(Into::into),
        }
    }
}

const fn info(
    title: &'static str,
    keywords: &'static str,
    icon: &'static str,
    tint: Option<&'static str>,
) -> EntryInfo {
    EntryInfo {
        title,
        keywords,
        icon,
        tint,
    }
}

/// An index entry's name, the words it is found by and its tile. A page a row opens borrows General's.
pub(super) fn entry_info(entry: IndexEntry) -> EntryInfo {
    use SettingsPage as P;
    match entry {
        IndexEntry::Page { page } => match page {
            P::Search => info(
                "settings.page.search",
                "settings.keywords.search",
                "search",
                Some(tint::BLUE),
            ),
            P::Appearance => info(
                "settings.appearance",
                "settings.keywords.appearance",
                "palette",
                Some(tint::PINK),
            ),
            P::Tabs => info(
                "settings.page.tabs",
                "settings.keywords.tabs",
                "tabs",
                Some(tint::ORANGE),
            ),
            P::Sync => info(
                "settings.page.sync",
                "settings.keywords.sync",
                "sync",
                Some(tint::GREEN),
            ),
            P::Privacy => info(
                "settings.privacy",
                "settings.keywords.privacy",
                "lock",
                Some(tint::INDIGO),
            ),
            P::Passwords => info(
                "settings.page.passwords",
                "settings.keywords.passwords",
                "key",
                Some(tint::GREY),
            ),
            P::Youtube => info(
                "settings.group.youtube",
                "settings.keywords.youtube",
                "video",
                Some(tint::RED),
            ),
            P::About => info("settings.about", "settings.keywords.about", "mark", None),
            _ => info(
                "settings.page.general",
                "settings.keywords.general",
                "settings",
                Some(tint::GREY),
            ),
        },
        IndexEntry::Action { action } => match action {
            IndexAction::Bookmarks => info(
                "settings.bookmarks",
                "settings.keywords.bookmarks",
                "bookmark",
                Some(tint::AMBER),
            ),
            IndexAction::History => info(
                "settings.history",
                "settings.keywords.history",
                "history",
                Some(tint::PURPLE),
            ),
            IndexAction::Downloads => info(
                "settings.downloads",
                "settings.keywords.downloads",
                "download",
                Some(tint::BLUE),
            ),
            IndexAction::Import => info(
                "settings.import",
                "settings.keywords.import",
                "import",
                Some(tint::GREEN),
            ),
            IndexAction::Report => info(
                "settings.reportProblem",
                "settings.keywords.report",
                "error",
                Some(tint::ORANGE),
            ),
        },
    }
}

fn is_index_page(page: SettingsPage) -> bool {
    page.parent().is_none()
}

/// A page's name, as its header and the head say it.
pub(super) fn page_title(page: SettingsPage) -> &'static str {
    use SettingsPage as P;
    match page {
        P::DefaultBrowser => "settings.defaultBrowser",
        P::Language => "settings.language",
        P::Swipe => "settings.swipe",
        P::AppLinks => "settings.appLinks",
        P::CustomEngine => "settings.page.customEngine",
        P::Wallpaper => "settings.wallpaper",
        P::AppIcon => "settings.group.appIcon",
        P::TextSize => "settings.pageZoom",
        P::Archive => "settings.archiveInactive",
        P::StartPage => "settings.startPageAfter",
        P::SyncJoin => "settings.page.syncJoin",
        P::SyncPhrase => "settings.page.syncPhrase",
        _ => entry_info(IndexEntry::Page { page }).title,
    }
}

/// A page's one line under its name; the pages a row opens have none, as in Yab.
pub(super) fn page_blurb(page: SettingsPage) -> Option<&'static str> {
    use SettingsPage as P;
    Some(match page {
        P::General => "settings.blurb.general",
        P::Search => "settings.blurb.search",
        P::Appearance => "settings.blurb.appearance",
        P::Tabs => "settings.blurb.tabs",
        P::Sync => "settings.blurb.sync",
        P::Privacy => "settings.blurb.privacy",
        P::Passwords => "settings.blurb.passwords",
        P::Youtube => "settings.blurb.youtube",
        P::About => "settings.blurb.about",
        P::DefaultBrowser => "settings.blurb.defaultBrowser",
        _ => return None,
    })
}

/// A page's tile in its header: the index's, or the row's glyph for a page a row opens.
pub fn page_tile(page: SettingsPage) -> Option<SettingsTile> {
    if is_index_page(page) {
        return Some(entry_info(IndexEntry::Page { page }).tile());
    }
    (page == SettingsPage::DefaultBrowser).then(|| SettingsTile {
        icon: "globe".into(),
        tint: Some(tint::BLUE.into()),
    })
}

struct ArchiveOption {
    days: Option<f64>,
    label: &'static str,
    short: &'static str,
}

const ARCHIVE_OPTIONS: [ArchiveOption; 5] = [
    ArchiveOption {
        days: Some(0.5),
        label: "settings.archive.halfDay",
        short: "settings.archive.halfDayShort",
    },
    ArchiveOption {
        days: Some(1.0),
        label: "settings.archive.oneDay",
        short: "settings.archive.oneDayShort",
    },
    ArchiveOption {
        days: Some(7.0),
        label: "settings.archive.week",
        short: "settings.archive.weekShort",
    },
    ArchiveOption {
        days: Some(30.0),
        label: "settings.archive.month",
        short: "settings.archive.monthShort",
    },
    ArchiveOption {
        days: None,
        label: "settings.archive.never",
        short: "settings.archive.never",
    },
];

const THEMES: [(ThemeChoice, &str); 3] = [
    (ThemeChoice::System, "settings.theme.system"),
    (ThemeChoice::Light, "settings.theme.light"),
    (ThemeChoice::Dark, "settings.theme.dark"),
];

const SWIPE_MODES: [(SwipeMode, &str); 3] = [
    (SwipeMode::Anywhere, "settings.swipe.anywhere"),
    (SwipeMode::Edges, "settings.swipe.edges"),
    (SwipeMode::Off, "settings.swipe.off"),
];

const APP_LINKS: [(AppLinks, &str); 2] = [
    (AppLinks::App, "settings.appLinks.app"),
    (AppLinks::Browser, "settings.appLinks.browser"),
];

struct Credit {
    name: &'static str,
    licence: &'static str,
    url: &'static str,
    android: bool,
}

const fn credit(name: &'static str, licence: &'static str, url: &'static str) -> Credit {
    Credit {
        name,
        licence,
        url,
        android: false,
    }
}

const fn android_credit(name: &'static str, licence: &'static str, url: &'static str) -> Credit {
    Credit {
        name,
        licence,
        url,
        android: true,
    }
}

/// The software Bay is built from, and the licence each ships under. Names and licences stay as their projects write them.
const CREDITS: [Credit; 14] = [
    credit("Bay", "Apache-2.0", SOURCE_URL),
    credit(
        "Cra",
        "MIT · © 2026 Victor Kildahl",
        "https://github.com/VictorKildahl/cra",
    ),
    credit(
        "Yab",
        "Apache-2.0 · © 2026 Serafim Korablev",
        "https://github.com/yetanotherbrowser/yab",
    ),
    android_credit("Chromium", "BSD-3-Clause", "https://www.chromium.org/"),
    credit(
        "adblock-rust",
        "MPL-2.0",
        "https://github.com/brave/adblock-rust",
    ),
    credit(
        "uBlock Origin",
        "GPL-3.0",
        "https://github.com/gorhill/uBlock",
    ),
    credit(
        "brave/adblock-resources",
        "MPL-2.0",
        "https://github.com/brave/adblock-resources",
    ),
    credit(
        "EasyList, EasyPrivacy",
        "GPL-3.0 / CC BY-SA 3.0",
        "https://easylist.to/",
    ),
    credit(
        "Peter Lowe's list",
        "pgl.yoyo.org",
        "https://pgl.yoyo.org/adservers/",
    ),
    credit("React Native, Expo", "MIT", "https://github.com/expo/expo"),
    credit(
        "HeroUI Native",
        "MIT",
        "https://github.com/heroui-inc/heroui-native",
    ),
    android_credit(
        "Material Symbols",
        "Apache-2.0",
        "https://github.com/google/material-design-icons",
    ),
    android_credit("Inter", "OFL-1.1", "https://github.com/rsms/inter"),
    credit("Caveat", "OFL-1.1", "https://github.com/googlefonts/caveat"),
];

/// An enum's name as it is saved: "dark", "edges", "browser".
fn tag(value: &impl Serialize) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn label_of<T: PartialEq + Copy>(options: &[(T, &'static str)], value: T) -> Option<&'static str> {
    options
        .iter()
        .find(|(id, _)| *id == value)
        .map(|(_, label)| *label)
}

/// What the index says under an entry's name: the setting it is on, or how many there are.
pub fn index_value(
    entry: IndexEntry,
    ctx: &SettingsContext,
    counts: IndexCounts,
) -> Option<String> {
    index_value_in(entry, ctx, counts, &Words::new(&ctx.locale))
}

pub(super) fn index_value_in(
    entry: IndexEntry,
    ctx: &SettingsContext,
    counts: IndexCounts,
    words: &Words,
) -> Option<String> {
    let count = |n: u32, one: &str, many: &str| {
        (n != 0).then(|| {
            if n == 1 {
                words.t(one)
            } else {
                words.with(many, &[("count", n.to_string())])
            }
        })
    };
    match entry {
        IndexEntry::Action { action } => match action {
            IndexAction::Bookmarks => count(
                counts.bookmarks,
                "bookmarks.folderOne",
                "bookmarks.folderCount",
            ),
            IndexAction::History => count(
                counts.history,
                "settings.historyOnePage",
                "settings.historyPages",
            ),
            IndexAction::Downloads => count(
                counts.downloads,
                "settings.downloadsOneFile",
                "settings.downloadsFiles",
            ),
            IndexAction::Report => Some(match counts.crashes {
                0 => words.t("settings.reportProblem.detail"),
                1 => words.t("settings.reportProblem.oneError"),
                n => words.with("settings.reportProblem.errors", &[("count", n.to_string())]),
            }),
            IndexAction::Import => None,
        },
        IndexEntry::Page { page } => match page {
            SettingsPage::Search => engine_name(ctx, words),
            SettingsPage::Appearance => {
                Some(words.t(label_of(&THEMES, ctx.prefs.theme).unwrap_or("settings.theme.system")))
            }
            SettingsPage::Privacy => {
                let paused = &ctx.prefs.blocking_paused_hosts;
                if !paused.is_empty() {
                    Some(words.with(
                        "settings.paused.count",
                        &[("count", paused.len().to_string())],
                    ))
                } else if ctx.prefs.block_content {
                    Some(words.t("settings.blockContent"))
                } else {
                    None
                }
            }
            SettingsPage::About => Some(ctx.version.clone()),
            SettingsPage::Sync => (ctx.sync.status != SyncStatus::Off)
                .then(|| sync_status_text(ctx.sync.status, words)),
            _ => None,
        },
    }
}

fn engine_name(ctx: &SettingsContext, words: &Words) -> Option<String> {
    if ctx.prefs.search_engine_id == CUSTOM_ENGINE_ID {
        return Some(words.t("settings.customEngine"));
    }
    ctx.engines
        .iter()
        .find(|engine| engine.id == ctx.prefs.search_engine_id)
        .map(|engine| engine.name.clone())
}

fn default_value(ctx: &SettingsContext, words: &Words) -> Option<String> {
    match ctx.default_browser {
        DefaultBrowser::Default => Some(words.t("settings.default.yes")),
        DefaultBrowser::Not => Some(words.t("settings.default.no")),
        _ => None,
    }
}

/// Under the default browser's state: what it means, or where to make Bay the default.
fn default_footer(is_default: bool, ctx: &SettingsContext, words: &Words) -> String {
    if is_default {
        return words.t("settings.default.isDefault");
    }
    words.t(match ctx.platform {
        SettingsPlatform::Ios => "settings.default.howIos",
        SettingsPlatform::Android => "settings.default.howAndroid",
    })
}

fn start_page_label(hours: Option<i64>, words: &Words) -> String {
    match hours {
        None => words.t("settings.startPage.never"),
        Some(1) => words.t("settings.startPage.oneHour"),
        Some(hours) => words.with("settings.startPage.hours", &[("hours", hours.to_string())]),
    }
}

fn row(
    id: impl Into<String>,
    test_id: impl Into<String>,
    label: String,
    kind: RowKind,
) -> SettingsRow {
    SettingsRow {
        id: id.into(),
        test_id: test_id.into(),
        label,
        detail: None,
        value: None,
        icon: None,
        kind,
        danger: false,
        disabled: false,
    }
}

impl SettingsRow {
    fn icon(mut self, icon: &str) -> Self {
        self.icon = Some(icon.into());
        self
    }

    fn value(mut self, value: Option<String>) -> Self {
        self.value = value;
        self
    }

    fn detail(mut self, detail: Option<String>) -> Self {
        self.detail = detail;
        self
    }

    fn danger(mut self) -> Self {
        self.danger = true;
        self
    }

    fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

fn section(id: &str, rows: Vec<SettingsRow>) -> SettingsSection {
    SettingsSection {
        id: id.into(),
        title: None,
        rows,
        footer: None,
        footer_test_id: None,
    }
}

impl SettingsSection {
    fn title(mut self, title: Option<String>) -> Self {
        self.title = title;
        self
    }

    fn footer(mut self, footer: String) -> Self {
        self.footer = Some(footer);
        self
    }

    fn footer_test_id(mut self, id: &str) -> Self {
        self.footer_test_id = Some(id.into());
        self
    }
}

fn toggle(
    id: &str,
    test_id: &str,
    label: String,
    on: bool,
    set: impl Fn(bool) -> SettingsAction,
) -> SettingsRow {
    row(
        id,
        test_id,
        label,
        RowKind::Toggle {
            on,
            when_on: set(true),
            when_off: set(false),
        },
    )
}

fn choice(
    id: impl Into<String>,
    test_id: impl Into<String>,
    label: String,
    selected: bool,
    action: SettingsAction,
) -> SettingsRow {
    row(id, test_id, label, RowKind::Choice { selected, action })
}

fn opens(id: &str, test_id: &str, label: String, page: SettingsPage) -> SettingsRow {
    row(
        id,
        test_id,
        label,
        RowKind::Page {
            page,
            checked: false,
        },
    )
}

fn act(id: &str, test_id: &str, label: String, action: SettingsAction) -> SettingsRow {
    row(id, test_id, label, RowKind::Action { action })
}

fn info_row(id: &str, test_id: &str, label: String) -> SettingsRow {
    row(id, test_id, label, RowKind::Info)
}

fn change(update: PreferencesUpdate) -> SettingsAction {
    SettingsAction::Change { update }
}

/// A page's sections, top to bottom.
pub fn sections(page: SettingsPage, ctx: &SettingsContext) -> Vec<SettingsSection> {
    sections_in(page, ctx, &Words::new(&ctx.locale))
}

pub(super) fn sections_in(
    page: SettingsPage,
    ctx: &SettingsContext,
    words: &Words,
) -> Vec<SettingsSection> {
    let t = |key: &str| words.t(key);
    let prefs = &ctx.prefs;
    use SettingsPage as P;

    match page {
        P::General => vec![
            section(
                "browser",
                vec![
                    opens(
                        "defaultBrowser",
                        "settings-default-browser",
                        t("settings.defaultBrowser"),
                        P::DefaultBrowser,
                    )
                    .icon("globe")
                    .value(default_value(ctx, words)),
                    opens(
                        "language",
                        "settings-language",
                        t("settings.language"),
                        P::Language,
                    )
                    .icon("translate")
                    .value(Some(match ctx.language.saved {
                        None => t("settings.language.system"),
                        Some(_) => locale_name(&ctx.language.current).to_owned(),
                    })),
                ],
            ),
            section(
                "moving",
                vec![
                    opens("swipe", "settings-swipe", t("settings.swipe"), P::Swipe)
                        .icon("back")
                        .value(Some(t(label_of(&SWIPE_MODES, prefs.swipe_to_navigate)
                            .unwrap_or("settings.swipe.anywhere")))),
                    toggle(
                        "pullToRefresh",
                        "settings-pull-refresh",
                        t("settings.pullToRefresh"),
                        prefs.pull_to_refresh,
                        |on| {
                            change(PreferencesUpdate {
                                pull_to_refresh: Some(on),
                                ..Default::default()
                            })
                        },
                    )
                    .icon("reload"),
                    opens(
                        "appLinks",
                        "settings-app-links",
                        t("settings.appLinks"),
                        P::AppLinks,
                    )
                    .icon("link")
                    .value(Some(t(match prefs.app_links {
                        AppLinks::App => "settings.appLinks.app",
                        AppLinks::Browser => "settings.appLinks.browser",
                    }))),
                ],
            ),
            section(
                "launch",
                vec![
                    toggle(
                        "openSearchOnLaunch",
                        "settings-search-on-launch",
                        t("settings.searchOnLaunch"),
                        prefs.open_search_on_launch,
                        |on| {
                            change(PreferencesUpdate {
                                open_search_on_launch: Some(on),
                                ..Default::default()
                            })
                        },
                    )
                    .icon("keyboard"),
                ],
            )
            .footer(t("settings.searchOnLaunch.detail")),
            section(
                "welcome",
                vec![act(
                    "showWelcome",
                    "settings-show-welcome",
                    t("settings.showWelcome"),
                    SettingsAction::ShowWelcome,
                )],
            )
            .footer(t("settings.showWelcome.note")),
        ],

        P::Search => {
            let custom = prefs.search_engine_id == CUSTOM_ENGINE_ID;
            let name = engine_name(ctx, words).unwrap_or_default();
            let mut rows: Vec<SettingsRow> = ctx
                .engines
                .iter()
                .map(|engine| {
                    choice(
                        format!("engine.{}", engine.id),
                        format!("settings-engine-{}", engine.id),
                        engine.name.clone(),
                        engine.id == prefs.search_engine_id,
                        SettingsAction::ChooseEngine {
                            id: engine.id.clone(),
                        },
                    )
                })
                .collect();
            rows.push(
                row(
                    "engine.custom",
                    "settings-engine-custom",
                    t("settings.customEngine"),
                    RowKind::Page {
                        page: P::CustomEngine,
                        checked: custom,
                    },
                )
                .detail(Some(
                    prefs
                        .custom_search_url
                        .clone()
                        .unwrap_or_else(|| t("settings.customEngine.detail")),
                )),
            );
            let suggestions_footer = if !prefs.search_suggestions {
                t("settings.searchSuggestions.off")
            } else if name.is_empty() {
                t("settings.searchSuggestions.default")
            } else {
                words.with("settings.searchSuggestions.on", &[("engine", name.clone())])
            };
            vec![
                section("engine", rows)
                    .title(Some(t("settings.searchEngine")))
                    .footer(words.with("settings.search.engineNote", &[("engine", name)])),
                section(
                    "suggestions",
                    vec![toggle(
                        "suggestions",
                        "settings-suggestions",
                        t("settings.searchSuggestions"),
                        prefs.search_suggestions,
                        |on| {
                            change(PreferencesUpdate {
                                search_suggestions: Some(on),
                                ..Default::default()
                            })
                        },
                    )],
                )
                .footer(suggestions_footer),
            ]
        }

        P::Appearance => {
            let mut result = vec![
                section(
                    "theme",
                    THEMES
                        .iter()
                        .map(|(theme, label)| {
                            let id = tag(theme);
                            choice(
                                format!("theme.{id}"),
                                format!("settings-theme-{id}"),
                                t(label),
                                prefs.theme == *theme,
                                change(PreferencesUpdate {
                                    theme: Some(*theme),
                                    ..Default::default()
                                }),
                            )
                        })
                        .collect(),
                )
                .title(Some(t("settings.group.theme")))
                .footer(t("settings.appearance.note")),
                section(
                    "startPage",
                    vec![
                        opens(
                            "wallpaper",
                            "settings-wallpaper",
                            t("settings.wallpaper"),
                            P::Wallpaper,
                        )
                        .icon("wallpaper")
                        .value(Some(ctx.wallpaper_name.clone())),
                        opens(
                            "textSize",
                            "settings-text-size",
                            t("settings.pageZoom"),
                            P::TextSize,
                        )
                        .icon("textSize")
                        .value(Some(format!("{}%", prefs.text_size))),
                    ],
                )
                .title(Some(t("settings.group.startPage"))),
            ];
            if let Some(icon) = &ctx.app_icon_name {
                result.push(
                    section(
                        "appIcon",
                        vec![
                            opens(
                                "appIcon",
                                "settings-app-icon",
                                t("settings.group.appIcon"),
                                P::AppIcon,
                            )
                            .icon("mark")
                            .value(Some(icon.clone())),
                        ],
                    )
                    .footer(t("settings.appIcon.note")),
                );
            }
            result
        }

        P::Tabs => {
            let archive = ARCHIVE_OPTIONS
                .iter()
                .find(|option| option.days == prefs.archive_after_days);
            let mut result = vec![section(
                "quiet",
                vec![
                    opens(
                        "archive",
                        "settings-archive",
                        t("settings.archiveInactive"),
                        P::Archive,
                    )
                    .icon("archive")
                    .value(archive.map(|option| t(option.short))),
                    opens(
                        "startPage",
                        "settings-start-page",
                        t("settings.startPageAfter"),
                        P::StartPage,
                    )
                    .icon("history")
                    .value(Some(match prefs.start_page_after_hours {
                        None => t("settings.startPage.never"),
                        Some(hours) => words.with(
                            "settings.startPage.hoursAway",
                            &[("hours", hours.to_string())],
                        ),
                    })),
                ],
            )];
            if ctx.open_tab_count > 0 {
                result.push(
                    section(
                        "export",
                        vec![
                            act(
                                "export",
                                "settings-export-tabs",
                                t("settings.exportTabs"),
                                SettingsAction::ExportTabs,
                            )
                            .icon("share"),
                        ],
                    )
                    .footer(if ctx.open_tab_count == 1 {
                        t("settings.exportTabs.one")
                    } else {
                        words.with(
                            "settings.exportTabs.count",
                            &[("count", ctx.open_tab_count.to_string())],
                        )
                    }),
                );
            }
            result
        }

        P::Privacy => privacy(ctx, words),

        P::Passwords => {
            let logins = ctx.logins.as_deref().unwrap_or_default();
            let rows = if logins.is_empty() {
                vec![
                    info_row(
                        "none",
                        "settings-passwords-none",
                        t("settings.passwords.none"),
                    )
                    .icon("key"),
                ]
            } else {
                logins
                    .iter()
                    .map(|login| {
                        act(
                            &format!("login.{}.{}", login.origin, login.username),
                            &format!("saved-login-{}-{}", login.origin, login.username),
                            login.username.clone(),
                            SettingsAction::ForgetLogin {
                                login: LoginSummary::clone(login),
                            },
                        )
                        .icon("key")
                        .detail(Some(login.origin.clone()))
                        .value(Some(t("settings.passwords.delete")))
                        .danger()
                    })
                    .collect()
            };
            vec![
                section("saved", rows)
                    .title((!logins.is_empty()).then(|| t("settings.group.passwords")))
                    .footer(t("settings.passwords.note")),
            ]
        }

        P::Youtube => {
            let youtube = prefs.youtube;
            let set = |with: fn(YouTubeCleanup, bool) -> YouTubeCleanup| {
                move |on| {
                    change(PreferencesUpdate {
                        youtube: Some(with(youtube, on)),
                        ..Default::default()
                    })
                }
            };
            vec![
                section(
                    "youtube",
                    vec![
                        toggle(
                            "shorts",
                            "settings-yt-shorts",
                            t("settings.youtube.shorts"),
                            youtube.shorts,
                            set(|youtube, shorts| YouTubeCleanup { shorts, ..youtube }),
                        ),
                        toggle(
                            "suggestions",
                            "settings-yt-suggestions",
                            t("settings.youtube.suggestions"),
                            youtube.suggestions,
                            set(|youtube, suggestions| YouTubeCleanup {
                                suggestions,
                                ..youtube
                            }),
                        )
                        .detail(Some(t("settings.youtube.suggestionsDetail"))),
                        toggle(
                            "distractions",
                            "settings-yt-distractions",
                            t("settings.youtube.distractions"),
                            youtube.distractions,
                            set(|youtube, distractions| YouTubeCleanup {
                                distractions,
                                ..youtube
                            }),
                        )
                        .detail(Some(t("settings.youtube.distractionsDetail"))),
                    ],
                )
                .footer(t("settings.youtube.note")),
            ]
        }

        P::About => vec![
            section(
                "bay",
                vec![
                    info_row("version", "settings-about-version", "Bay".into())
                        .icon("mark")
                        .value(Some(ctx.version.clone())),
                ],
            )
            .footer(t("settings.about.privacy"))
            .footer_test_id("settings-about-privacy"),
            section(
                "links",
                vec![
                    act(
                        "source",
                        "settings-about-source",
                        t("settings.about.source"),
                        SettingsAction::OpenLink {
                            url: SOURCE_URL.into(),
                        },
                    )
                    .icon("link")
                    .detail(Some(SOURCE_URL.replacen("https://", "", 1))),
                    act(
                        "issue",
                        "settings-about-issues",
                        t("settings.about.issue"),
                        SettingsAction::OpenLink {
                            url: ISSUES_URL.into(),
                        },
                    )
                    .icon("error")
                    .detail(Some(t("settings.about.issueDetail"))),
                ],
            ),
            section(
                "licences",
                CREDITS
                    .iter()
                    .filter(|credit| !credit.android || ctx.platform == SettingsPlatform::Android)
                    .map(|credit| {
                        act(
                            &format!("credit.{}", credit.name),
                            &format!("settings-credit-{}", credit.name),
                            credit.name.into(),
                            SettingsAction::OpenLink {
                                url: credit.url.into(),
                            },
                        )
                        .detail(Some(credit.licence.into()))
                    })
                    .collect(),
            )
            .title(Some(t("settings.group.licences")))
            .footer(t("settings.about.licencesNote")),
        ],

        P::DefaultBrowser => {
            let is_default = ctx.default_browser == DefaultBrowser::Default;
            vec![
                section(
                    "state",
                    vec![
                        info_row(
                            "state",
                            "settings-default-state",
                            t("settings.defaultBrowser"),
                        )
                        .icon("globe")
                        .value(default_value(ctx, words)),
                    ],
                )
                .footer(default_footer(is_default, ctx, words)),
                section(
                    "open",
                    vec![act(
                        "open",
                        "default-browser-open",
                        if ctx.platform == SettingsPlatform::Android && !is_default {
                            t("settings.default.make")
                        } else {
                            t("default.open")
                        },
                        SettingsAction::MakeDefault,
                    )],
                ),
            ]
        }

        P::Language => {
            let mut rows = vec![
                choice(
                    "system",
                    "settings-language-system",
                    t("settings.language.system"),
                    ctx.language.saved.is_none(),
                    SettingsAction::SetLanguage { locale: None },
                )
                .detail(Some(words.with(
                    "settings.language.systemDetail",
                    &[("language", locale_name(&ctx.language.device).to_owned())],
                ))),
            ];
            rows.extend(crate::i18n::LOCALE_IDS.iter().map(|locale| {
                choice(
                    *locale,
                    format!("settings-language-{locale}"),
                    locale_name(locale).to_owned(),
                    ctx.language.saved.as_deref() == Some(*locale),
                    SettingsAction::SetLanguage {
                        locale: Some((*locale).to_owned()),
                    },
                )
            }));
            vec![section("language", rows)]
        }

        P::Swipe => vec![
            section(
                "swipe",
                SWIPE_MODES
                    .iter()
                    .map(|(mode, label)| {
                        let id = tag(mode);
                        choice(
                            id.clone(),
                            format!("settings-swipe-{id}"),
                            t(label),
                            prefs.swipe_to_navigate == *mode,
                            change(PreferencesUpdate {
                                swipe_to_navigate: Some(*mode),
                                ..Default::default()
                            }),
                        )
                    })
                    .collect(),
            )
            .footer(t("settings.swipe.note")),
        ],

        P::AppLinks => vec![
            section(
                "appLinks",
                APP_LINKS
                    .iter()
                    .map(|(option, label)| {
                        let id = tag(option);
                        choice(
                            id.clone(),
                            format!("settings-app-links-{id}"),
                            t(label),
                            prefs.app_links == *option,
                            change(PreferencesUpdate {
                                app_links: Some(*option),
                                ..Default::default()
                            }),
                        )
                    })
                    .collect(),
            )
            .footer(t("settings.appLinks.note")),
        ],

        P::Archive => vec![
            section(
                "archive",
                ARCHIVE_OPTIONS
                    .iter()
                    .map(|option| {
                        let id = option
                            .days
                            .map_or_else(|| "never".to_owned(), number_string);
                        choice(
                            id.clone(),
                            format!("settings-archive-{id}"),
                            t(option.label),
                            prefs.archive_after_days == option.days,
                            SettingsAction::SetArchiveAfterDays { days: option.days },
                        )
                    })
                    .collect(),
            )
            .footer(t("settings.archive.note")),
        ],

        P::StartPage => vec![
            section(
                "startPage",
                START_PAGE_HOURS
                    .iter()
                    .map(|hours| {
                        let id =
                            hours.map_or_else(|| "never".to_owned(), |hours| hours.to_string());
                        choice(
                            id.clone(),
                            format!("settings-start-page-{id}"),
                            start_page_label(*hours, words),
                            prefs.start_page_after_hours == *hours,
                            change(PreferencesUpdate {
                                start_page_after_hours: Some((*hours).into()),
                                ..Default::default()
                            }),
                        )
                    })
                    .collect(),
            )
            .footer(t("settings.startPage.note")),
        ],

        P::Sync => sync(ctx, words),

        P::CustomEngine | P::Wallpaper | P::AppIcon | P::TextSize | P::SyncJoin | P::SyncPhrase => {
            Vec::new()
        }
    }
}

fn privacy(ctx: &SettingsContext, words: &Words) -> Vec<SettingsSection> {
    let t = |key: &str| words.t(key);
    let prefs = &ctx.prefs;
    let busy = ctx.clear_stage == ClearStage::Busy;

    let mut result = vec![
        section(
            "blocking",
            vec![
                toggle(
                    "blockContent",
                    "settings-block-content",
                    t("settings.blockContent"),
                    prefs.block_content,
                    |on| SettingsAction::SetBlockContent { on },
                )
                .icon("shield")
                .disabled(busy),
            ],
        )
        .footer(ctx.blocker_detail.clone())
        .footer_test_id("settings-block-content-detail"),
    ];

    if !prefs.blocking_paused_hosts.is_empty() {
        result.push(
            section(
                "paused",
                prefs
                    .blocking_paused_hosts
                    .iter()
                    .map(|host| {
                        act(
                            &format!("paused.{host}"),
                            &format!("settings-paused-{host}"),
                            host.clone(),
                            SettingsAction::ResumeBlocking { host: host.clone() },
                        )
                        .value(Some(t("settings.paused.resume")))
                    })
                    .collect(),
            )
            .title(Some(t("settings.group.paused")))
            .footer(t("settings.paused.note")),
        );
    }

    let clear_rows = if ctx.clear_stage == ClearStage::Idle {
        vec![
            act(
                "clearData",
                "settings-clear-data",
                t("settings.clearData"),
                SettingsAction::AskToClear,
            )
            .icon("delete")
            .danger(),
        ]
    } else {
        vec![
            act(
                "clearData",
                "clear-data-confirm",
                t(if busy {
                    "settings.clearingData"
                } else {
                    "settings.clearAllData"
                }),
                SettingsAction::ConfirmClear,
            )
            .icon("delete")
            .danger()
            .disabled(busy),
            act(
                "keepData",
                "clear-data-cancel",
                t("settings.keepData"),
                SettingsAction::KeepData,
            )
            .disabled(busy),
        ]
    };
    // What clearing says under its rows: what it clears, that it is running, or that it failed.
    let clear = match ctx.clear_stage {
        ClearStage::Busy => section("data", clear_rows)
            .footer(t("settings.clearingWebsiteData"))
            .footer_test_id("clear-data-busy"),
        ClearStage::Failed => section("data", clear_rows)
            .footer(t("settings.clearDataFailed"))
            .footer_test_id("clear-data-error"),
        _ => section("data", clear_rows).footer(t("settings.clearAllData.detail")),
    };

    result.extend([
        section(
            "amp",
            vec![
                toggle(
                    "skipAmp",
                    "settings-skip-amp",
                    t("settings.skipAmp"),
                    prefs.skip_amp,
                    |on| {
                        change(PreferencesUpdate {
                            skip_amp: Some(on),
                            ..Default::default()
                        })
                    },
                )
                .icon("link"),
            ],
        )
        .footer(t("settings.skipAmp.detail")),
        section(
            "private",
            vec![
                toggle(
                    "lockPrivate",
                    "settings-lock-private",
                    t("settings.lockPrivate"),
                    prefs.lock_private_tabs,
                    |on| SettingsAction::SetLockPrivateTabs { on },
                )
                .icon("private"),
            ],
        )
        .footer(t("settings.lockPrivate.detail")),
        clear,
    ]);

    result
}

pub(super) fn sync_status_text(status: SyncStatus, words: &Words) -> String {
    words.t(match status {
        SyncStatus::Off => "sync.notYet",
        SyncStatus::Syncing => "sync.status.syncing",
        SyncStatus::Synced => "sync.status.synced",
        SyncStatus::Waiting => "sync.status.waiting",
        SyncStatus::Offline => "sync.status.offline",
        SyncStatus::Failed => "sync.status.failed",
    })
}

/// "Synced 5 min ago", and the like.
pub(crate) fn synced_ago(at: i64, now: i64, words: &Words) -> String {
    let minutes = (now - at).div_euclid(60_000);
    if minutes < 1 {
        words.t("sync.justNow")
    } else if minutes < 60 {
        words.with("sync.minutesAgo", &[("count", minutes.to_string())])
    } else if minutes < 60 * 24 {
        words.with("sync.hoursAgo", &[("count", (minutes / 60).to_string())])
    } else {
        words.with(
            "sync.daysAgo",
            &[("count", (minutes / (60 * 24)).to_string())],
        )
    }
}

static SCHEME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^https?://").unwrap());
static PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/.*").unwrap());

/// The host a tab's row says under its title.
fn host_of(url: &str) -> String {
    let rest = SCHEME.replace(url, "");
    let rest = rest.strip_prefix("www.").unwrap_or(&rest);
    PATH.replace(rest, "").into_owned()
}

fn sync(ctx: &SettingsContext, words: &Words) -> Vec<SettingsSection> {
    let t = |key: &str| words.t(key);
    let view = &ctx.sync;
    let now = ctx.now;

    if view.status == SyncStatus::Off {
        return vec![
            section(
                "join",
                vec![
                    row(
                        "joinCode",
                        "sync-join-code",
                        t("sync.join.code"),
                        RowKind::Page {
                            page: SettingsPage::SyncJoin,
                            checked: false,
                        },
                    )
                    .icon("desktop"),
                    row(
                        "joinPhrase",
                        "sync-join-phrase",
                        t("sync.join.phrase"),
                        RowKind::Page {
                            page: SettingsPage::SyncPhrase,
                            checked: false,
                        },
                    )
                    .icon("key"),
                ],
            )
            .footer(t("sync.join.note")),
        ];
    }

    let mut result = vec![section(
        "status",
        vec![
            info_row("status", "sync-status", t("sync.status"))
                .icon("sync")
                .value(Some(sync_status_text(view.status, words)))
                .detail(
                    view.last_synced_at
                        .filter(|at| *at != 0)
                        .map(|at| synced_ago(at, now, words)),
                ),
            act("now", "sync-now", t("sync.now"), SettingsAction::SyncNow)
                .disabled(view.status == SyncStatus::Syncing),
        ],
    )];

    if !view.devices.is_empty() {
        result.push(
            section(
                "devices",
                view.devices
                    .iter()
                    .map(|device| {
                        info_row(
                            &format!("device.{}", device.id),
                            &format!("sync-device-{}", device.id),
                            device.name.clone(),
                        )
                        .value(Some(if device.current {
                            t("sync.thisPhone")
                        } else {
                            match device.last_seen.filter(|at| *at != 0) {
                                Some(at) => synced_ago(at, now, words),
                                None => t("sync.notYet"),
                            }
                        }))
                    })
                    .collect(),
            )
            .title(Some(t("sync.devices"))),
        );
    }

    for device in &view.remote_tabs {
        result.push(
            section(
                &format!("tabs.{}", device.device_id),
                device
                    .tabs
                    .iter()
                    .enumerate()
                    .map(|(index, tab)| {
                        let host = host_of(&tab.url);
                        act(
                            &format!("tab.{}.{index}", device.device_id),
                            &format!("sync-tab-{}-{index}", device.device_id),
                            if tab.title.is_empty() {
                                host.clone()
                            } else {
                                tab.title.clone()
                            },
                            SettingsAction::OpenSyncedTab {
                                url: tab.url.clone(),
                            },
                        )
                        .detail(Some(host))
                    })
                    .collect(),
            )
            .title(Some(
                words.with("sync.tabsOn", &[("device", device.name.clone())]),
            )),
        );
    }

    let types = [
        (SyncType::Tabs, "tabs", "tabs", view.types.tabs),
        (
            SyncType::Bookmarks,
            "bookmarks",
            "bookmark",
            view.types.bookmarks,
        ),
        (SyncType::History, "history", "history", view.types.history),
    ];
    result.extend([
        section(
            "what",
            types
                .iter()
                .map(|(kind, name, icon, on)| {
                    let kind = *kind;
                    toggle(
                        &format!("type.{name}"),
                        &format!("sync-type-{name}"),
                        t(&format!("sync.type.{name}")),
                        *on,
                        |on| SettingsAction::SetSyncType { kind, on },
                    )
                    .icon(icon)
                })
                .collect(),
        )
        .title(Some(t("sync.what")))
        .footer(t("sync.what.note")),
        section(
            "leave",
            vec![
                act(
                    "leave",
                    "sync-leave",
                    t("sync.leave"),
                    SettingsAction::LeaveSync,
                )
                .danger(),
            ],
        )
        .footer(t("sync.leave.note")),
    ]);

    result
}

/// Sub-pages whose rows the search reads under their parent's entry.
fn nested(page: SettingsPage) -> &'static [SettingsPage] {
    match page {
        SettingsPage::General => &[
            SettingsPage::DefaultBrowser,
            SettingsPage::Language,
            SettingsPage::Swipe,
            SettingsPage::AppLinks,
        ],
        SettingsPage::Tabs => &[SettingsPage::Archive, SettingsPage::StartPage],
        _ => &[],
    }
}

/// The index as the search reads it: every entry, with its page's rows and those of the pages a row there opens.
pub fn search_entries(ctx: &SettingsContext) -> Vec<SearchEntry> {
    let words = Words::new(&ctx.locale);
    INDEX
        .iter()
        .flat_map(|card| card.iter())
        .map(|entry| {
            let info = entry_info(*entry);
            let rows = match entry {
                IndexEntry::Action { .. } => Vec::new(),
                IndexEntry::Page { page } => {
                    let own = sections_in(*page, ctx, &words)
                        .into_iter()
                        .flat_map(|section| section.rows)
                        .map(|row| SearchRow {
                            id: row.id,
                            label: row.label,
                            detail: row.detail,
                            value: row.value,
                            page: None,
                        });
                    let further = nested(*page).iter().flat_map(|sub| {
                        sections_in(*sub, ctx, &words)
                            .into_iter()
                            .flat_map(|section| section.rows)
                            .map(|row| SearchRow {
                                id: row.id,
                                label: row.label,
                                detail: row.detail,
                                value: None,
                                page: Some(*sub),
                            })
                    });
                    own.chain(further).collect()
                }
            };
            SearchEntry {
                entry: *entry,
                title: words.t(info.title),
                keywords: words.t(info.keywords),
                rows,
            }
        })
        .collect()
}
