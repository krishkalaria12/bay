//! Reading saved state: anything unknown, out of range or broken is repaired or replaced by its default, as the Expo
//! app's `parseBrowserData` and `parsePreferences` do, so a document either app wrote reads the same in both.

use std::collections::{BTreeMap, HashSet};

use serde_json::{Map, Value};

use super::bookmarks::{BOOKMARKS_ROOT, empty_bookmarks, parse_bookmarks};
use super::model::{
    ARCHIVE_LIMIT, DOWNLOAD_LIMIT, FAVICON_LIMIT, INTERRUPTED_DOWNLOAD, PERSONAL_SPACE_ID,
    SPACE_ICON_LENGTH, START_PAGE_HOURS, SiteSettingInput, TEXT_SIZE_MAX, TEXT_SIZE_MIN,
    TEXT_SIZE_STEP, cap_history, personal_space, with_space_emoji,
};
use super::types::*;
use crate::js;

/// Why saved state couldn't be read at all.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum StateError {
    #[error("The saved browsing state could not be read.")]
    Unreadable,
}

fn string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn non_empty(value: Option<&Value>) -> Option<&str> {
    string(value).filter(|text| !text.is_empty())
}

fn number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

fn timestamp(value: Option<&Value>) -> Option<i64> {
    number(value)
        .filter(|number| *number >= 0.0)
        .map(|number| number as i64)
}

fn enum_value<T: serde::de::DeserializeOwned>(value: Option<&Value>) -> Option<T> {
    value
        .filter(|value| value.is_string())
        .and_then(|value| serde_json::from_value(value.clone()).ok())
}

fn unique_by<T, K: std::hash::Hash + Eq>(entries: Vec<T>, key: impl Fn(&T) -> K) -> Vec<T> {
    let mut seen = HashSet::new();
    entries
        .into_iter()
        .filter(|entry| seen.insert(key(entry)))
        .collect()
}

fn is_plain_host(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
}

static EMPTY: std::sync::LazyLock<Map<String, Value>> = std::sync::LazyLock::new(Map::new);

fn record(value: Option<&Value>) -> &Map<String, Value> {
    value.and_then(Value::as_object).unwrap_or(&EMPTY)
}

/// Reader settings as saved, with anything unknown taken from `fallback`.
pub fn parse_reader_settings(value: &Value, fallback: ReaderSettings) -> ReaderSettings {
    let settings = record(Some(value));
    ReaderSettings {
        theme: enum_value(settings.get("theme")).unwrap_or(fallback.theme),
        font: enum_value(settings.get("font")).unwrap_or(fallback.font),
        size: number(settings.get("size")).map_or(fallback.size, |size| {
            js::round(size).clamp(14.0, 28.0) as i64
        }),
    }
}

/// Element selectors as saved: trimmed, without empty or repeated ones.
pub fn parse_selectors(value: &Value) -> Vec<String> {
    let Some(selectors) = value.as_array() else {
        return Vec::new();
    };
    unique_by(
        selectors
            .iter()
            .filter_map(Value::as_str)
            .map(|selector| js::trim(selector).to_owned())
            .filter(|selector| !selector.is_empty())
            .collect(),
        Clone::clone,
    )
}

fn snap_text_size(size: f64) -> i64 {
    (js::round(size / TEXT_SIZE_STEP as f64) * TEXT_SIZE_STEP as f64) as i64
}

/// One site's setting as saved: zoom snapped to the steps, the rest plainly true or false.
pub fn parse_site_setting(value: &Value) -> SiteSetting {
    let setting = record(Some(value));
    let block_off = setting.get("blockOff").and_then(Value::as_array);
    SiteSetting {
        text_size: number(setting.get("textSize"))
            .map(|size| snap_text_size(size).clamp(TEXT_SIZE_MIN, TEXT_SIZE_MAX)),
        reader: setting.get("reader") == Some(&Value::Bool(true)),
        desktop_mode: setting.get("desktopMode") == Some(&Value::Bool(true)),
        block_off: SITE_BLOCK_GROUPS
            .into_iter()
            .filter(|group| {
                block_off.is_some_and(|list| {
                    list.contains(&serde_json::to_value(group).unwrap_or_default())
                })
            })
            .collect(),
        swipe: enum_value(setting.get("swipe")),
    }
}

pub fn parse_site_setting_input(input: &SiteSettingInput) -> SiteSetting {
    parse_site_setting(&serde_json::to_value(input).unwrap_or_default())
}

/// The preferences as the JSON object they're saved as.
pub fn preferences_json(preferences: &BrowserPreferences) -> Map<String, Value> {
    match serde_json::to_value(preferences) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// Saved preferences with anything unknown or out of range replaced by its default.
pub fn parse_preferences(saved: &Map<String, Value>) -> BrowserPreferences {
    let defaults = BrowserPreferences::default();
    let get = |key: &str| saved.get(key);
    let photo = string(get("wallpaperPhoto"))
        .filter(|uri| js::is_file_uri(uri))
        .map(str::to_owned);
    let youtube = record(get("youtube"));
    let flag = |map: &Map<String, Value>, key: &str| map.get(key) == Some(&Value::Bool(true));
    BrowserPreferences {
        search_engine_id: non_empty(get("searchEngineId"))
            .map_or(defaults.search_engine_id, str::to_owned),
        archive_after_days: match get("archiveAfterDays") {
            Some(Value::Null) => None,
            value => number(value)
                .filter(|days| [0.5, 1.0, 7.0, 30.0].contains(days))
                .or(defaults.archive_after_days),
        },
        block_content: get("blockContent")
            .and_then(Value::as_bool)
            .unwrap_or(defaults.block_content),
        blocking_paused_hosts: unique_by(
            get("blockingPausedHosts")
                .and_then(Value::as_array)
                .map(|hosts| {
                    hosts
                        .iter()
                        .filter_map(Value::as_str)
                        .filter(|host| is_plain_host(host))
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            Clone::clone,
        ),
        lock_private_tabs: flag(saved, "lockPrivateTabs"),
        reader: parse_reader_settings(get("reader").unwrap_or(&Value::Null), defaults.reader),
        hidden_elements: record(get("hiddenElements"))
            .iter()
            .filter_map(|(host, selectors)| {
                let host = js::normalize_host(host)?;
                let selectors = parse_selectors(selectors);
                (!selectors.is_empty()).then_some((host, selectors))
            })
            .collect(),
        site_settings: record(get("siteSettings"))
            .iter()
            .filter_map(|(host, setting)| {
                let host = js::normalize_host(host)?;
                let setting = parse_site_setting(setting);
                (!setting.is_default()).then_some((host, setting))
            })
            .collect(),
        wallpaper: match enum_value::<WallpaperId>(get("wallpaper")) {
            Some(WallpaperId::Photo) if photo.is_some() => WallpaperId::Photo,
            Some(WallpaperId::Photo) | None => defaults.wallpaper,
            Some(builtin) => builtin,
        },
        wallpaper_photo: photo,
        theme: enum_value(get("theme")).unwrap_or(defaults.theme),
        text_size: number(get("textSize"))
            .filter(|size| (TEXT_SIZE_MIN as f64..=TEXT_SIZE_MAX as f64).contains(size))
            .map_or(defaults.text_size, snap_text_size),
        search_suggestions: get("searchSuggestions") != Some(&Value::Bool(false)),
        skip_amp: get("skipAmp") != Some(&Value::Bool(false)),
        pull_to_refresh: get("pullToRefresh") != Some(&Value::Bool(false)),
        start_page_after_hours: number(get("startPageAfterHours")).and_then(|hours| {
            START_PAGE_HOURS
                .into_iter()
                .flatten()
                .find(|choice| *choice as f64 == hours)
        }),
        youtube: YouTubeCleanup {
            shorts: flag(youtube, "shorts"),
            suggestions: flag(youtube, "suggestions"),
            distractions: flag(youtube, "distractions"),
        },
        // Saved before the welcome existed: whoever saved it has used Bay already.
        welcomed: get("welcomed") != Some(&Value::Bool(false)),
        // Off unless chosen.
        open_search_on_launch: flag(saved, "openSearchOnLaunch"),
        custom_search_url: string(get("customSearchUrl"))
            .filter(|url| js::is_custom_search_url(url))
            .map(str::to_owned),
        // Saved before the tips existed: whoever saved it knows Bay already, so they show to people new to it.
        tips_seen: match get("tipsSeen").and_then(Value::as_array) {
            None => TIP_IDS.to_vec(),
            Some(seen) => TIP_IDS
                .into_iter()
                .filter(|id| seen.contains(&serde_json::to_value(id).unwrap_or_default()))
                .collect(),
        },
        swipe_to_navigate: enum_value(get("swipeToNavigate")).unwrap_or(defaults.swipe_to_navigate),
        app_links: if string(get("appLinks")) == Some("browser") {
            AppLinks::Browser
        } else {
            AppLinks::App
        },
    }
}

fn parse_tab(value: &Value) -> Option<BrowserTab> {
    let entry = value.as_object()?;
    let id = non_empty(entry.get("id"))?;
    let title = string(entry.get("title"))?;
    let url = string(entry.get("url")).filter(|url| url.is_empty() || js::is_web_address(url))?;
    Some(BrowserTab {
        id: id.into(),
        url: url.into(),
        title: title.into(),
        created_at: timestamp(entry.get("createdAt"))?,
        last_visit: timestamp(entry.get("lastVisit"))?,
        favicon: string(entry.get("favicon")).map(str::to_owned),
        snapshot: string(entry.get("snapshot"))
            .filter(|uri| js::is_file_uri(uri))
            .map(str::to_owned),
        private: false,
        space_id: PERSONAL_SPACE_ID.into(),
        folder_id: None,
    })
}

fn array(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// Saved bookmarks: a tree per space. A document from before spaces kept their own holds one tree (its root is
/// BOOKMARKS_ROOT), which is the personal space's.
fn parse_space_bookmarks(
    value: Option<&Value>,
    space_ids: &HashSet<String>,
) -> BTreeMap<String, Bookmarks> {
    let mut trees = BTreeMap::from([(PERSONAL_SPACE_ID.to_owned(), empty_bookmarks())]);
    let Some(saved) = value.and_then(Value::as_object) else {
        return trees;
    };
    if record(saved.get(BOOKMARKS_ROOT)).get("kind") == Some(&Value::String("folder".into())) {
        trees.insert(PERSONAL_SPACE_ID.into(), parse_bookmarks(value));
        return trees;
    }
    for (space_id, tree) in saved {
        if space_ids.contains(space_id) {
            trees.insert(space_id.clone(), parse_bookmarks(Some(tree)));
        }
    }
    trees
}

/// Reads saved state and repairs its collections before any screen sees it. `fallback` gives the tabs (and current
/// tab) when the document has none.
pub fn parse_browser_data(
    value: &Value,
    fallback: &BrowserData,
) -> Result<BrowserData, StateError> {
    let document = value.as_object().ok_or(StateError::Unreadable)?;
    let version = number(document.get("version"));
    if version != Some(1.0) && version != Some(2.0) {
        return Err(StateError::Unreadable);
    }
    let get = |key: &str| document.get(key);

    // Documents saved before spaces existed (v1) have none; everything falls into the personal space.
    let saved_spaces: Vec<BrowserSpace> = array(get("spaces"))
        .iter()
        .filter_map(|entry| {
            let entry = entry.as_object()?;
            Some(BrowserSpace {
                id: non_empty(entry.get("id"))?.into(),
                name: non_empty(entry.get("name"))
                    .map_or_else(|| "Space".into(), |name| js::slice(name, 40)),
                color: enum_value(entry.get("color")).unwrap_or(SpaceColor::Gray),
                icon: non_empty(entry.get("icon")).map(|icon| js::slice(icon, SPACE_ICON_LENGTH)),
            })
        })
        .collect();
    // The personal space is always there: its history and bookmarks are the ones that sync.
    let spaces = with_space_emoji(
        if saved_spaces
            .iter()
            .any(|space| space.id == PERSONAL_SPACE_ID)
        {
            saved_spaces
        } else {
            let mut all = vec![BrowserSpace {
                icon: None,
                ..personal_space()
            }];
            all.extend(saved_spaces);
            all
        },
    );
    let space_ids: HashSet<String> = spaces.iter().map(|space| space.id.clone()).collect();
    let space_of = |entry: &Map<String, Value>, fallback: &str| -> String {
        string(entry.get("spaceId"))
            .filter(|id| space_ids.contains(*id))
            .unwrap_or(fallback)
            .to_owned()
    };

    let folders: Vec<BrowserFolder> = array(get("folders"))
        .iter()
        .filter_map(|entry| {
            let entry = entry.as_object()?;
            let space_id = string(entry.get("spaceId")).filter(|id| space_ids.contains(*id))?;
            Some(BrowserFolder {
                id: non_empty(entry.get("id"))?.into(),
                space_id: space_id.into(),
                name: js::slice(non_empty(entry.get("name"))?, 40),
            })
        })
        .collect();

    let tabs: Vec<BrowserTab> = unique_by(
        array(get("tabs"))
            .iter()
            .filter_map(|entry| {
                let mut tab = parse_tab(entry)?;
                let entry = entry.as_object()?;
                tab.space_id = space_of(entry, PERSONAL_SPACE_ID);
                tab.folder_id = string(entry.get("folderId"))
                    .filter(|id| folders.iter().any(|folder| folder.id == *id))
                    .map(str::to_owned);
                Some(tab)
            })
            .collect(),
        |tab| tab.id.clone(),
    );

    let history: Vec<HistoryEntry> = array(get("history"))
        .iter()
        .filter_map(|entry| {
            let entry = entry.as_object()?;
            let url = string(entry.get("url")).filter(|url| js::is_web_address(url))?;
            let visits = number(entry.get("visits")).filter(|visits| *visits > 0.0)?;
            Some(HistoryEntry {
                // History saved before spaces kept their own is the personal space's.
                space_id: space_of(entry, PERSONAL_SPACE_ID),
                url: url.into(),
                title: string(entry.get("title"))?.into(),
                favicon: string(entry.get("favicon")).map(str::to_owned),
                last_visit: timestamp(entry.get("lastVisit"))?,
                visits: visits.floor() as i64,
            })
        })
        .collect();

    let first_space = spaces[0].id.clone();
    let pinned_sites: Vec<PinnedSite> = array(get("pinnedSites"))
        .iter()
        .filter_map(|entry| {
            let entry = entry.as_object()?;
            let row = string(entry.get("kind")) == Some("row");
            Some(PinnedSite {
                id: non_empty(entry.get("id"))?.into(),
                url: string(entry.get("url"))
                    .filter(|url| js::is_web_address(url))?
                    .into(),
                title: string(entry.get("title"))?.into(),
                favicon: string(entry.get("favicon")).map(str::to_owned),
                // Pins from before spaces had them were the start page's: they become the first space's Essentials.
                space_id: space_of(entry, &first_space),
                kind: if row {
                    PinKind::Row
                } else {
                    PinKind::Essential
                },
                folder_id: string(entry.get("folderId"))
                    .filter(|_| row)
                    .map(str::to_owned),
            })
        })
        .collect();
    // Once per space; a pinned row whose folder went is loose in its space.
    let pinned_sites: Vec<PinnedSite> = unique_by(pinned_sites, |site| {
        (site.space_id.clone(), site.url.clone())
    })
    .into_iter()
    .map(|mut site| {
        if site.folder_id.as_ref().is_some_and(|id| {
            !folders
                .iter()
                .any(|folder| &folder.id == id && folder.space_id == site.space_id)
        }) {
            site.folder_id = None;
        }
        site
    })
    .collect();

    let mut archive: Vec<ArchivedTab> = array(get("archive"))
        .iter()
        .filter_map(|entry| {
            let mut tab = parse_tab(entry).filter(|tab| !tab.url.is_empty())?;
            let entry = entry.as_object()?;
            let closed_at = timestamp(entry.get("closedAt"))?;
            tab.space_id = space_of(entry, PERSONAL_SPACE_ID);
            Some(ArchivedTab { tab, closed_at })
        })
        .collect();
    archive.sort_by_key(|entry| std::cmp::Reverse(entry.closed_at));
    let mut archive = unique_by(unique_by(archive, |entry| entry.tab.url.clone()), |entry| {
        entry.tab.id.clone()
    });
    archive.truncate(ARCHIVE_LIMIT);

    let mut downloads: Vec<DownloadItem> = unique_by(
        array(get("downloads"))
            .iter()
            .filter_map(|entry| {
                let entry = entry.as_object()?;
                let state: DownloadState = enum_value(entry.get("state"))?;
                let bytes = |key: &str| {
                    number(entry.get(key))
                        .filter(|value| *value > 0.0)
                        .map_or(0, |value| value as i64)
                };
                // A download Bay was running when it quit can't be resumed.
                let interrupted = state == DownloadState::Downloading;
                Some(DownloadItem {
                    id: non_empty(entry.get("id"))?.into(),
                    url: string(entry.get("url")).unwrap_or_default().into(),
                    filename: string(entry.get("filename"))?.into(),
                    state: if interrupted {
                        DownloadState::Failed
                    } else {
                        state
                    },
                    received: bytes("received"),
                    total: bytes("total"),
                    path: non_empty(entry.get("path")).map(str::to_owned),
                    error: if interrupted {
                        Some(INTERRUPTED_DOWNLOAD.into())
                    } else {
                        string(entry.get("error")).map(str::to_owned)
                    },
                    waiting: None,
                    started_at: timestamp(entry.get("startedAt"))?,
                    private: false,
                })
            })
            .collect(),
        |item| item.id.clone(),
    );
    downloads.sort_by_key(|item| std::cmp::Reverse(item.started_at));
    downloads.truncate(DOWNLOAD_LIMIT);

    let active_tab = string(get("activeTabId")).and_then(|id| tabs.iter().find(|tab| tab.id == id));
    let active_space_id = string(get("activeSpaceId"))
        .filter(|id| space_ids.contains(*id))
        .map_or(first_space, str::to_owned);
    let mut active_tab_ids: BTreeMap<String, String> = record(get("activeTabIds"))
        .iter()
        .filter_map(|(space_id, tab_id)| {
            let tab_id = tab_id.as_str()?;
            (space_ids.contains(space_id) && tabs.iter().any(|tab| tab.id == tab_id))
                .then(|| (space_id.clone(), tab_id.to_owned()))
        })
        .collect();
    let resolved = active_tab
        .or_else(|| tabs.iter().find(|tab| tab.space_id == active_space_id))
        .or_else(|| tabs.first())
        .map_or_else(|| fallback.active_tab_id.clone(), |tab| tab.id.clone());
    if !resolved.is_empty() && !active_tab_ids.contains_key(&active_space_id) {
        active_tab_ids.insert(active_space_id.clone(), resolved.clone());
    }

    let mut favicons: indexmap::IndexMap<String, String> = record(get("favicons"))
        .iter()
        .filter_map(|(host, uri)| {
            let uri = uri.as_str().filter(|uri| js::is_file_uri(uri))?;
            is_plain_host(host).then(|| (host.clone(), uri.to_owned()))
        })
        .collect();
    let excess = favicons.len().saturating_sub(FAVICON_LIMIT);
    favicons.drain(..excess);

    Ok(BrowserData {
        bookmarks: parse_space_bookmarks(get("bookmarks"), &space_ids),
        spaces,
        active_space_id,
        active_tab_ids,
        folders,
        tabs: if tabs.is_empty() {
            fallback.tabs.clone()
        } else {
            tabs
        },
        active_tab_id: resolved,
        history: cap_history(history),
        pinned_sites,
        archive,
        downloads,
        preferences: parse_preferences(record(get("preferences"))),
        favicons,
        left_at: number(get("leftAt")).map(|at| at as i64),
    })
}
