//! Plugins, one copy for every desktop: a folder with a `manifest.json` and a script, which Bay runs in a sandboxed
//! web page of its own, out of process (WebKit's on the Mac, a `chrome-untrusted://` frame on Windows and Linux).
//!
//! This crate is what the hosts share: the manifest's format ([`manifest`]), adding, listing and removing plugins in
//! the host's plugins folder, the files a sandbox may read ([`files::read`]), the runtime it loads first
//! ([`files::RUNTIME`]) and its content security policy ([`files::CSP`]). What a plugin may do once it runs is the
//! app's to check (apps/browser/src/lib/plugins).

pub mod ffi;
pub mod files;
pub mod manifest;
