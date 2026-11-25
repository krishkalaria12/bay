//! Bay's browser import readers, one copy for every desktop: each takes another browser's profile (or an exported
//! file) and gives the JSON the app's import reads, the same shape on macOS (`packages/import/ios`) and on Windows and
//! Linux (`packages/import/portable`).
//!
//! The hosts keep what differs: finding browsers, unlocking their secrets (Keychain, DPAPI, Secret Service), writing
//! into Bay's own profile, and the macOS-only sources (Safari, Dia). Every reader is checked against what the C++
//! readers answered for the shared fixtures (`packages/import/fixtures/wire`).

mod arc;
mod crypto;
mod failure;
pub mod ffi;
mod firefox_logins;
mod readers;
mod secrets;
mod sessions;
mod snapshot;

pub use arc::{arc_sidebar, arc_sidebar_from_json};
pub use failure::Failure;
pub use firefox_logins::{firefox_logins, firefox_logins_from_json, firefox_master_key};
pub use readers::{
    Cancel, HistoryOptions, chromium_bookmarks, chromium_time, extensions, firefox_bookmarks,
    history, parse_netscape_bookmarks, parse_passwords_csv,
};
pub use secrets::{
    Opener, Plain, Secrets, Sink, Unlock, chromium_autofill, chromium_cookies, chromium_logins,
    firefox_cookies,
};
pub use sessions::{
    chromium_tabs, firefox_tabs, firefox_tabs_from_json, zen_spaces, zen_spaces_from_json,
};
pub use snapshot::Snapshot;
