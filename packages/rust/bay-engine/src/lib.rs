//! The desktop app's engine: Chromium (NNCore on macOS) started, its windows and tabs, and the routing that lets the
//! UI hear a window's input before the page does. docs/gpui-desktop-plan.html, decision D4.
//!
//! Phase 0 drives NNCore's Objective-C API through the app's host glue (`macos`); the versioned C ABI the plan settles
//! on replaces that in Phase 1.

#[cfg(target_os = "macos")]
pub mod macos;
