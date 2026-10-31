//! Bay's content blocker, shared by the engines (mobile today; desktop can link the same C ABI).
//!
//! The same filter lists drive every engine. Android matches every request against an [`adblock::Engine`] and
//! asks it for cosmetic rules; iOS converts the lists into WebKit content-blocking rules once and lets WebKit apply
//! them. Tracking-parameter stripping lives here too, so both engines clean navigations the same way.

mod blocker;
mod ffi;
#[cfg(target_os = "android")]
mod jni_bridge;
mod tracking;

pub use blocker::{content_blocking_rules, Blocker};
pub use tracking::TrackingParams;
