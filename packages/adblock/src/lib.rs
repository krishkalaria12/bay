//! Bay's content blocker, shared by the engines: desktop's native core and both mobile engines.
//!
//! The same filter lists drive every engine. Android matches every request against an [`adblock::Engine`] and
//! asks it for cosmetic rules; iOS converts the lists into WebKit content-blocking rules once and lets WebKit apply
//! them. Desktop matches every request of its Chromium engine against a [`Blocker`] built from the same lists, and
//! caches the compiled engine ([`Blocker::serialize`]). Tracking-parameter stripping lives here too, so the engines
//! clean navigations the same way.

mod blocker;
mod ffi;
#[cfg(target_os = "android")]
mod jni_bridge;
mod preprocess;
mod tracking;

pub use blocker::{
    content_blocking_rules, load_cached, Blocker, Check, FilterList, ListCounts, PageResources,
    TRUSTED_SCRIPTLETS,
};
pub use preprocess::{preprocess, preprocess_for, Platform};
pub use tracking::TrackingParams;
