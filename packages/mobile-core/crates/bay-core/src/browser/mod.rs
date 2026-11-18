//! The browser screen's pure helpers: the page a link from another app opens and the `bay://` commands, plain words
//! for a page that failed to load, the saved-logins document, history's day groups, which downloads open themselves,
//! favicon checks, which navigation reports run page scripts, pages' media reports, and where a link's redirects end. The Expo app's
//! `src/browser/{incomingLink,pageErrors,logins,downloads,favicons,navigationEvents,linkResolver}.ts` and
//! `src/panels/historyGroups.ts`, checked against `fixtures/browser.jsonl` (`scripts/record-fixtures.mjs browser`) and
//! their ported tests.

mod days;
mod errors;
mod filter_lists;
mod icons;
mod links;
mod logins;
mod messages;
mod picker;
mod reader;
mod resolve;
mod timing;
mod youtube;

pub use days::{DayBounds, DayGroup, DayGroupId, group_by_day};
pub use errors::{PageErrorId, PageErrorKind, PageErrorText, describe_page_error, page_error_id};
pub use filter_lists::{FilterGroup, FilterList, FilterListStore, ListsOnDisk, filter_lists};
pub use icons::{KNOWN_LIMIT, SHARP_WIDTH, icon_width, is_image, known_sites_without_icons};
pub use links::{BayCommand, bay_command, incoming_link, share_link};
pub use logins::{SavedLogin, format_saved_logins, origin_of, parse_saved_logins};
pub use messages::{ImagePress, MediaReport, parse_image_press, parse_media_message};
pub use picker::{
    ColorSwatches, CssDeclaration, FontKind, FontOrigin, InspectedElement, InspectedFont,
    InspectedRule, PickedElement, font_origin, parse_inspected_element, parse_picked_message,
};
pub use reader::{
    READER_SIZE_MAX, READER_SIZE_MIN, ReaderSizeSteps, ReaderThemeColors, reader_size_steps,
    reader_themes, reader_variables,
};
pub use resolve::{MAX_REDIRECTS, RESOLVE_TIMEOUT_MS, resolve_link, resolve_with};
pub use timing::{
    Navigation, NavigationReport, ScriptPlan, ScriptTiming, initial_timing, same_navigation,
    scripts_for, should_hide,
};
pub use youtube::youtube_selectors;

use std::sync::LazyLock;

use regex::Regex;

use crate::js::{site_host, trim};
use crate::store::handle::BrowserStore;
use crate::store::model::INTERRUPTED_DOWNLOAD;
use crate::store::{DownloadItem, DownloadState};

static OPENS_ITSELF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u:\.(pkpass|pkpasses|ics))$").unwrap());

/// Files a person downloads to use somewhere else straight away: a Wallet pass and a calendar invitation open in the
/// phone's own viewer as soon as they arrive, which offers Add to Wallet or Add to Calendar.
#[uniffi::export]
pub fn opens_when_finished(filename: &str) -> bool {
    OPENS_ITSELF.is_match(trim(filename))
}

/// Whether a download failed because Bay closed during it: the downloads sheet says so in the app's language, where
/// the engine's own failures arrive already worded.
#[uniffi::export]
pub fn download_interrupted(item: DownloadItem) -> bool {
    item.state == DownloadState::Failed && item.error.as_deref() == Some(INTERRUPTED_DOWNLOAD)
}

/// How many files came from the site a page is on, for its Site Settings. Private ones are never counted there.
pub fn downloads_from(downloads: &[DownloadItem], page_url: &str) -> u32 {
    let host = site_host(page_url);
    if host.is_empty() {
        return 0;
    }
    downloads
        .iter()
        .filter(|item| !item.private && site_host(&item.url) == host)
        .count() as u32
}

#[uniffi::export]
impl BrowserStore {
    /// How many files came from the site a page is on.
    pub fn downloads_from(&self, page_url: &str) -> u32 {
        downloads_from(&self.snapshot().downloads, page_url)
    }

    /// The sites Bay already shows without an icon yet, to fetch theirs.
    pub fn sites_without_icons(&self) -> Vec<String> {
        known_sites_without_icons(&self.snapshot(), KNOWN_LIMIT)
    }
}
