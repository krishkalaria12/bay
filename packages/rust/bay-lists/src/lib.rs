//! The content blocker's filter lists, as the desktops keep them: the catalogue (`filter_lists.json`), the person's
//! settings, the list files in `<data>/Content Blocker` and the compiled engine cached beside them.
//!
//! macOS (`NNCoreContentBlocker.mm`) and Windows and Linux (`webui/content_blocker.cc`) each kept their own copy of
//! this. The hosts keep what differs: threads, timers, downloads and handing the engine to the request filter. Every
//! file this crate reads or writes has the layout both hosts already used, so existing data opens unchanged.
//!
//! - [`Catalogue`]: the lists Bay offers, in order.
//! - [`Settings`]: on or off, the chosen lists and the sites the blocker is paused on (`settings.json`).
//! - [`files`]: the list files, their freshness (`lists.json`) and the cached engine (`engine.dat`).

mod catalogue;
pub mod ffi;
pub mod files;
mod hosts;
mod settings;

pub use catalogue::{Catalogue, CatalogueList};
pub use files::{Built, ListSource, Stored};
pub use hosts::{covers, host_of};
pub use settings::{CustomList, LiveSettings, MY_FILTERS, Settings};

/// adblock-rust's version, shown in Settings › Privacy.
pub const VERSION: &str = "adblock-rust 0.13.5";

/// Bump with a change to how lists compile (the crate, its features): every cached engine is rebuilt.
pub const ENGINE_FORMAT: &str = "bay-adblock 6";

/// When the hosts first check for list updates after launch, in seconds.
pub const FIRST_UPDATE_SECONDS: f64 = 60.0;

/// How often the hosts check for list updates after that, in seconds.
pub const UPDATE_EVERY_SECONDS: f64 = 3.0 * 3600.0;
