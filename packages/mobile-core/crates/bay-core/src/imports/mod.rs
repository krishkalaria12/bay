//! Importing from other browsers: what their export files hold (a Netscape bookmarks file, Safari's and Takeout's
//! History.json), what an import adds, the browsers a phone may have, and the links in a shared tab list. The Expo
//! app's `src/import/{exports,apply,browsers}.ts` and `src/browser/importTabs.ts`, checked against
//! `fixtures/import.jsonl` (`scripts/record-fixtures.mjs import`). Unpacking archives stays native: the apps hand the
//! core each file's name and text.

mod apply;
mod browsers;
mod exports;
mod tabs;

use serde::{Deserialize, Serialize};

pub use apply::{bookmark_drafts, draft_link_count, export_notes};
pub use browsers::{IOS_BROWSERS, TAKEOUT_URL, android_browsers, android_method, ios_browsers};
pub use exports::{
    FAVORITES_LIMIT, bookmark_links, decode_entities, is_bookmarks_html, link_count,
    parse_bookmarks_html, parse_history_json, read_export, web_address,
};
pub use tabs::imported_tabs;

/// Where a folder came from in its browser, when the export marks it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "camelCase")]
pub enum BookmarkRole {
    Favorites,
    Toolbar,
    ReadingList,
    Other,
}

/// A bookmark or a folder of them, as the export had it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct ImportedBookmark {
    pub title: String,
    /// Absent on a folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Milliseconds since the epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<ImportedBookmark>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<BookmarkRole>,
}

impl ImportedBookmark {
    pub(crate) fn folder(title: String) -> Self {
        Self {
            title,
            url: None,
            added_at: None,
            children: Some(Vec::new()),
            role: None,
        }
    }

    pub(crate) fn children(&self) -> &[ImportedBookmark] {
        self.children.as_deref().unwrap_or_default()
    }
}

/// One page of imported history: every visit to an address, counted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct ImportedVisit {
    pub url: String,
    pub title: String,
    pub visits: i64,
    pub last_visit: i64,
}

/// A file the native side found: its name in the archive and its text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct ExportFile {
    pub name: String,
    pub text: String,
}

/// What an export held, ready to review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct ExportContents {
    /// The bookmarks, as one folder whose children are the export's own top level.
    pub bookmarks: ImportedBookmark,
    /// The sites the browser shows first (Safari's Favorites, Chrome's bookmarks bar), for Bay's start page.
    pub favorites: Vec<ImportedBookmark>,
    /// Newest first, one entry per address.
    pub history: Vec<ImportedVisit>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum ImportError {
    /// Not one file held bookmarks or history Bay can read.
    #[error("This file doesn't hold bookmarks or history Bay can read.")]
    UnknownExport,
}

/// What the export held that stays in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct ExportNotes {
    /// It had passwords (a CSV, or a file named for them).
    pub passwords: bool,
    /// It had payment cards.
    pub cards: bool,
    /// Bookmark or history files too large to read.
    pub too_large: Vec<String>,
}

/// How a browser's data gets to Bay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "camelCase")]
pub enum ImportMethod {
    Safari,
    Takeout,
    BookmarksFile,
    Paste,
}

/// A browser on this phone, as the import sheet lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct PhoneBrowser {
    pub id: String,
    pub name: String,
    pub method: ImportMethod,
    /// The app's icon as a data URL (Android); iOS doesn't share other apps' icons.
    pub icon: Option<String>,
}

/// A browser Android says is installed: its package, name and icon (empty when it has none).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct InstalledBrowser {
    pub id: String,
    pub name: String,
    pub icon: String,
}

/// A browser Bay can ask iOS about by URL scheme.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct QueryableBrowser {
    pub url: String,
    pub id: String,
    pub name: String,
    pub method: ImportMethod,
}

/// A tab found in exported text: its address and, when the line names it, its title.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct ImportedTab {
    pub url: String,
    pub title: String,
}

/// Reads every file an export held; see [`read_export`].
#[uniffi::export(name = "readExport")]
pub fn read_export_ffi(files: Vec<ExportFile>) -> Result<ExportContents, ImportError> {
    read_export(&files)
}

/// The imported tree as drafts, without the pages Bay already has (anywhere in `space`'s bookmarks) or that the
/// export names twice.
#[uniffi::export(name = "bookmarkDrafts")]
pub fn bookmark_drafts_ffi(
    root: ImportedBookmark,
    existing: crate::store::Bookmarks,
) -> Vec<crate::store::bookmarks::BookmarkDraft> {
    bookmark_drafts(&root, &existing)
}

/// What the native side left in the archive, read for what it means to the user.
#[uniffi::export(name = "exportNotes")]
pub fn export_notes_ffi(skipped: Vec<String>, too_large: Vec<String>) -> ExportNotes {
    export_notes(&skipped, &too_large)
}

/// The browsers Bay asks iOS about, in the order `ios_browsers` takes their answers.
#[uniffi::export(name = "iosQueryableBrowsers")]
pub fn ios_queryable_browsers() -> Vec<QueryableBrowser> {
    IOS_BROWSERS
        .iter()
        .map(|(url, id, name, method)| QueryableBrowser {
            url: (*url).into(),
            id: (*id).into(),
            name: (*name).into(),
            method: *method,
        })
        .collect()
}

/// iOS's browsers: Safari first, then each one that answered its URL scheme.
#[uniffi::export(name = "iosBrowsers")]
pub fn ios_browsers_ffi(answered: Vec<bool>) -> Vec<PhoneBrowser> {
    ios_browsers(&answered)
}

/// Android's browsers as the sheet lists them.
#[uniffi::export(name = "androidBrowsers")]
pub fn android_browsers_ffi(installed: Vec<InstalledBrowser>) -> Vec<PhoneBrowser> {
    android_browsers(&installed)
}

/// The links in a shared tab list.
#[uniffi::export(name = "importedTabs")]
pub fn imported_tabs_ffi(text: &str) -> Vec<ImportedTab> {
    imported_tabs(text)
}

/// The address Google Takeout opens with only Chrome chosen.
#[uniffi::export(name = "takeoutUrl")]
pub fn takeout_url() -> String {
    TAKEOUT_URL.into()
}
