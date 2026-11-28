//! The records the saved session holds, as the React Native app's store keeps them (apps/browser/src/store/types.ts).
//!
//! Two rules keep both apps safe on one data folder (docs/gpui-desktop-plan.html, D6):
//! - every record carries the fields this build doesn't name in `extra`, and writes them back unchanged;
//! - a field the app writes as `null` stays `null` (`Option<T>`, always written), a field it leaves out stays out
//!   (`Option<T>`, skipped when unset), and a field that can be either (`?: T | null`) keeps which it was
//!   (`Option<Option<T>>`).

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use serde_with::rust::double_option;

use crate::number::JsNumber;

/// Fields a record holds that this build doesn't model, in the order they were read.
pub type Extra = Map<String, Value>;

fn one() -> JsNumber {
    JsNumber(1.0)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Space {
    pub id: String,
    pub name: String,
    /// A preset ("plum", "blue", …); kept as written so a colour a newer build adds survives.
    pub color: String,
    pub icon: Option<String>,
    #[serde(default)]
    pub created_at: JsNumber,
    /// Another space's native profile, when this one shares its sign-ins.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shares_sign_ins: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub theme: Option<Option<SpaceTheme>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow_site: Option<bool>,
    /// Hours before unused tabs are cleaned up; `Some(None)` is never, unset is the app's setting.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub clean_up_after_hours: Option<Option<JsNumber>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folded: Option<bool>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A space's own colours (one to three, a gradient), how strongly they tint the window and its grain.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpaceTheme {
    pub colors: Vec<String>,
    pub intensity: JsNumber,
    pub grain: JsNumber,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWindow {
    pub id: String,
    pub space_id: String,
    #[serde(default)]
    pub incognito: bool,
    /// The tab each space last showed in this window, by space id.
    #[serde(default)]
    pub active_tab_ids: IndexMap<String, String>,
    #[serde(default)]
    pub sidebar_open: bool,
    /// "sidebar" or "top".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_layout: Option<String>,
    #[serde(default)]
    pub frame: Option<[JsNumber; 4]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<[JsNumber; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximized: Option<bool>,
    #[serde(default)]
    pub created_at: JsNumber,
    /// "small" for Little Bay, which the session never saves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub id: String,
    /// The window its page is in; empty when none has shown it since it was made or its window closed.
    #[serde(default)]
    pub window_id: String,
    pub space_id: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub favicon: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub muted: bool,
    #[serde(default = "one")]
    pub zoom: JsNumber,
    #[serde(default)]
    pub custom_title: Option<String>,
    #[serde(default)]
    pub custom_icon: Option<String>,
    #[serde(default)]
    pub pinned_url: Option<String>,
    #[serde(default)]
    pub opener_id: Option<String>,
    #[serde(default)]
    pub created_at: JsNumber,
    #[serde(default)]
    pub last_active_at: JsNumber,
    /// A row in the space's Pinned section, loose or in a folder (`folder_id`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_row: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_item: Option<LiveItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peek_of: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unloaded: Option<bool>,
    /// "chromium" or "webkit", once the page has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_pick: Option<EnginePick>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_tab_history: Option<NewTabHistory>,
    /// What the page is to load next. This and the two below live only while the app runs: they're never saved.
    #[serde(skip)]
    pub navigation: Option<Navigation>,
    /// A page the engine already made, to adopt instead of loading the address.
    #[serde(skip)]
    pub adopt_id: Option<String>,
    /// What a tab that hasn't loaded adopts when first shown: a reopened window's "restore:<tab>".
    #[serde(skip)]
    pub wake_adopt_id: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A load the tab asks its page for. `seq` tells two loads of one address apart.
#[derive(Clone, Debug, PartialEq)]
pub struct Navigation {
    pub url: String,
    pub seq: u64,
    pub user_initiated: bool,
}

impl Tab {
    /// A pinned page: an Essential (a pinned tile) or a pinned row.
    pub fn pinned_page(&self) -> bool {
        self.pinned || self.is_row()
    }

    pub fn is_row(&self) -> bool {
        self.pinned_row == Some(true)
    }

    pub fn is_unloaded(&self) -> bool {
        self.unloaded == Some(true)
    }

    /// It has a page, or will once shown: an address and a load or a page to adopt.
    pub fn is_loaded(&self) -> bool {
        !self.url.is_empty() && (self.navigation.is_some() || self.adopt_id.is_some())
    }
}

impl BrowserWindow {
    /// Little Bay: one page, no sidebar.
    pub fn is_small(&self) -> bool {
        self.kind.as_deref() == Some("small")
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveItem {
    pub folder_id: String,
    pub item_id: String,
    #[serde(flatten)]
    pub extra: Extra,
}

/// The engine the person picked for a tab, for the site it was on.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EnginePick {
    pub engine: String,
    pub site: String,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NewTabHistory {
    pub url: String,
    pub title: String,
    pub favicon: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabGroup {
    pub id: String,
    pub space_id: String,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub tab_ids: Vec<String>,
    #[serde(default)]
    pub created_at: JsNumber,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_ungroup: Option<bool>,
    /// The pinned tab whose links, opened behind, this group collects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_opener_id: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A folder of the Pinned section. Its members are its space's tabs with its id, in their list's order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedFolder {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// Where an empty folder sits: before this sibling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_id: Option<String>,
    pub space_id: String,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub created_at: JsNumber,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A Finder file or folder pinned in a space. Access grants stay with the native shell.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFilePin {
    pub id: String,
    pub space_id: String,
    pub path: String,
    pub name: String,
    /// "file" or "folder".
    pub kind: String,
    #[serde(default)]
    pub created_at: JsNumber,
    #[serde(default)]
    pub order: JsNumber,
    #[serde(default)]
    pub expanded: bool,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitView {
    pub id: String,
    pub tab_ids: Vec<String>,
    /// "horizontal" or "vertical".
    pub orientation: String,
    #[serde(default)]
    pub sizes: Vec<JsNumber>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<SplitStack>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SplitStack {
    pub index: JsNumber,
    pub sizes: [JsNumber; 2],
    #[serde(flatten)]
    pub extra: Extra,
}

/// What a closed tab keeps of its tab, to reopen it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSnapshot {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub favicon: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub muted: bool,
    #[serde(default = "one")]
    pub zoom: JsNumber,
    #[serde(default)]
    pub custom_title: Option<String>,
    #[serde(default)]
    pub custom_icon: Option<String>,
    pub space_id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub pinned_url: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_row: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_pick: Option<EnginePick>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// The group a closed tab was in.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GroupRef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A closed tab (Recently Closed), or a tab the clean-up put away (`cleaned_tabs`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedTab {
    /// "tab".
    pub kind: String,
    pub id: String,
    pub tab: TabSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub window_id: String,
    #[serde(default)]
    pub index: JsNumber,
    #[serde(default)]
    pub group: Option<GroupRef>,
    #[serde(default)]
    pub closed_at: JsNumber,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_tile: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub small: Option<bool>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A closed window: its tabs stay their space's, so reopening it brings the window back on its space.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedWindow {
    /// "window".
    pub kind: String,
    pub id: String,
    pub window: ClosedWindowPlacement,
    #[serde(default)]
    pub tabs: Vec<ClosedWindowTab>,
    #[serde(default)]
    pub groups: Vec<ClosedWindowGroup>,
    #[serde(default)]
    pub closed_at: JsNumber,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedWindowPlacement {
    pub space_id: String,
    #[serde(default)]
    pub sidebar_open: bool,
    #[serde(default)]
    pub frame: Option<[JsNumber; 4]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<[JsNumber; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximized: Option<bool>,
    /// The tab it showed, which it shows again when it comes back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shown_tab_id: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedWindowTab {
    #[serde(flatten)]
    pub tab: TabSnapshot,
    #[serde(default)]
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedWindowGroup {
    pub id: String,
    pub space_id: String,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub created_at: JsNumber,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_ungroup: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_opener_id: Option<String>,
    /// Its tabs, by their place in the closed window's `tabs`.
    #[serde(default)]
    pub tab_indexes: Vec<JsNumber>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A closed group (`closed_groups`), or a deleted one (`deleted_groups`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedGroup {
    /// "group".
    pub kind: String,
    pub id: String,
    pub group: ClosedGroupRef,
    #[serde(default)]
    pub tabs: Vec<TabSnapshot>,
    #[serde(default)]
    pub window_id: String,
    #[serde(default)]
    pub index: JsNumber,
    #[serde(default)]
    pub closed_at: JsNumber,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ClosedGroupRef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(flatten)]
    pub extra: Extra,
}
