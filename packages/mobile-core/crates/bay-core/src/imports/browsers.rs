//! The browsers a phone may have, and how each one's data reaches Bay. A phone's apps can't read each other's data, so
//! every way in goes through something the browser itself hands over: Safari's export, Google Takeout for Chrome, a
//! bookmarks file from the rest, or a shared tab list (Arc Search).

use std::sync::LazyLock;

use regex::Regex;

use super::{ImportMethod, InstalledBrowser, PhoneBrowser};

/// The address Google Takeout opens with only Chrome chosen.
pub const TAKEOUT_URL: &str = "https://takeout.google.com/settings/takeout/custom/chrome";

/// The browsers Bay can ask iOS about by URL scheme (the app's LSApplicationQueriesSchemes lists these schemes): the
/// scheme, id, name and how its data comes.
pub const IOS_BROWSERS: [(&str, &str, &str, ImportMethod); 5] = [
    ("googlechrome://", "chrome", "Chrome", ImportMethod::Takeout),
    (
        "firefox://",
        "firefox",
        "Firefox",
        ImportMethod::BookmarksFile,
    ),
    (
        "microsoft-edge-https://",
        "edge",
        "Edge",
        ImportMethod::BookmarksFile,
    ),
    ("brave://", "brave", "Brave", ImportMethod::BookmarksFile),
    (
        "ddgQuickLink://",
        "duckduckgo",
        "DuckDuckGo",
        ImportMethod::BookmarksFile,
    ),
];

/// Chrome and its beta, dev and canary channels: what they sync is in Takeout.
static CHROME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^com\.(android\.chrome|chrome\.(beta|dev|canary))$").unwrap());
/// Arc Search shares its open tabs as text.
static ARC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^company\.thebrowser\.").unwrap());

/// The method for an Android package.
#[uniffi::export]
pub fn android_method(id: &str) -> ImportMethod {
    if CHROME.is_match(id) {
        ImportMethod::Takeout
    } else if ARC.is_match(id) {
        ImportMethod::Paste
    } else {
        ImportMethod::BookmarksFile
    }
}

/// Android's browsers as the sheet lists them: the system's name and icon for each, in the order they came.
pub fn android_browsers(installed: &[InstalledBrowser]) -> Vec<PhoneBrowser> {
    installed
        .iter()
        .map(|app| PhoneBrowser {
            id: app.id.clone(),
            name: app.name.clone(),
            method: android_method(&app.id),
            icon: (!app.icon.is_empty()).then(|| app.icon.clone()),
        })
        .collect()
}

/// iOS's browsers: Safari first, then each one that answered its URL scheme.
pub fn ios_browsers(answered: &[bool]) -> Vec<PhoneBrowser> {
    let safari = PhoneBrowser {
        id: "safari".into(),
        name: "Safari".into(),
        method: ImportMethod::Safari,
        icon: None,
    };
    std::iter::once(safari)
        .chain(
            IOS_BROWSERS
                .iter()
                .zip(answered.iter().chain(std::iter::repeat(&false)))
                .filter(|(_, answered)| **answered)
                .map(|((_, id, name, method), _)| PhoneBrowser {
                    id: (*id).into(),
                    name: (*name).into(),
                    method: *method,
                    icon: None,
                }),
        )
        .collect()
}
