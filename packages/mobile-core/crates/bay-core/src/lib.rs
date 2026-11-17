//! Bay mobile's shared core. The Swift (iOS) and Kotlin (Android) apps call it through UniFFI's generated bindings:
//! it owns everything that runs without a device (the browser store, persistence, sync, address input), and the apps
//! own the views, the page engines and the operating system.

uniffi::setup_scaffolding!("bay_core");

pub mod browser;
pub mod i18n;
pub mod imports;
pub mod input;
pub mod js;
pub mod onboarding;
pub mod settings;
pub mod store;
pub mod sync;

/// The core's version, as the apps show it in Settings › About and send with crash reports.
#[uniffi::export]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_the_crate_version() {
        assert_eq!(super::version(), env!("CARGO_PKG_VERSION"));
    }
}
