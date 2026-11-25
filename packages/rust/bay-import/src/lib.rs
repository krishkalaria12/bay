//! Bay's browser import readers, one copy for every desktop: each takes another browser's profile (or an exported
//! file) and gives the JSON the app's import reads, the same shape on macOS (`packages/import/ios`) and on Windows and
//! Linux (`packages/import/portable`).
//!
//! The hosts keep what differs: finding browsers, unlocking their secrets (Keychain, DPAPI, Secret Service), writing
//! into Bay's own profile, and the macOS-only sources (Safari, Dia). Every reader is checked against what the C++
//! readers answered for the shared fixtures (`packages/import/fixtures/wire`).

mod arc;
mod failure;
pub mod ffi;
mod readers;
mod sessions;
mod snapshot;

pub use arc::arc_sidebar;
pub use failure::Failure;
pub use readers::{
    Cancel, HistoryOptions, chromium_bookmarks, chromium_time, extensions, firefox_bookmarks,
    history, parse_netscape_bookmarks, parse_passwords_csv,
};
pub use sessions::{chromium_tabs, firefox_tabs, zen_spaces};
pub use snapshot::Snapshot;
