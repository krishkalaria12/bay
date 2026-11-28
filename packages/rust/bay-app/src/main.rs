//! Bay on GPUI, Phase 0: one window that hosts a real Bay page under GPUI's drawing, a 500-row sidebar on GPUI's
//! virtual list, and a command bar drawn over the page (⌘L). It answers the plan's gate: the page in a GPUI window,
//! input over it, input methods, VoiceOver, scrolling. docs/gpui-desktop-plan.html, Phase 0.

#[cfg(target_os = "macos")]
mod spike;
#[cfg(target_os = "macos")]
mod text_input;

fn main() {
    #[cfg(target_os = "macos")]
    std::process::exit(spike::run());
    #[cfg(not(target_os = "macos"))]
    eprintln!(
        "bay: the GPUI app runs on macOS for now (docs/gpui-desktop-plan.html, Phase 6 for Windows and Linux)"
    );
}
