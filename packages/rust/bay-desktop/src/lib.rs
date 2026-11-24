//! The static library Bay's desktop hosts link: the macOS app (`BayNNCore.podspec`) and the Windows and Linux engine
//! (`webui/BUILD.gn`). It carries every shared crate's C functions; each crate keeps its own header, which the hosts
//! include directly (`packages/adblock/include/bay_adblock.h`).

/// The content blocker (`bay_blocker_*`, `bay_tracking_*`, `bay_content_blocking_rules`).
pub use bay_adblock::ffi::*;
