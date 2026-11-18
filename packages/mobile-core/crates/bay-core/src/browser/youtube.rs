//! YouTube clean-up: the elements Settings > YouTube hides (Shorts, suggestions, distractions). The Expo app's
//! `src/pagescripts/youtube.ts`.

use crate::input::url::host_of;
use crate::store::YouTubeCleanup;

// From Brave's YouTube lists (github.com/brave/adblock-lists, brave-lists/yt-*.txt, MPL-2.0): the plain CSS rules for
// youtube.com and m.youtube.com.
const SHORTS: &[&str] = &[
    "ytm-reel-shelf-renderer",
    "ytm-shorts-lockup-view-model-v2",
    ".big-shorts-singleton",
    ".pivot-shorts.pivot-bar-item-tab",
    r#"ytm-media-item:has(a[href^="/shorts/"])"#,
    r#".ytLockupViewModelWrapper:has(a[href^="/shorts/"])"#,
    r#".media-item-thumbnail-container[aria-hidden][href^="/shorts/"]"#,
    r#"ytd-rich-section-renderer:has(a[href^="/shorts/"])"#,
    r#"ytd-reel-shelf-renderer:has(a[href^="/shorts/"])"#,
    r#".yt-simple-endpoint[title="Shorts"]"#,
    ".ytGridShelfViewModelHost",
];
const SUGGESTIONS: &[&str] = &[
    r#"ytm-item-section-renderer[section-identifier="related-items"]"#,
    ".ytm-player-endscreen",
    "#related",
    ".ytp-endscreen-content",
];
const DISTRACTIONS: &[&str] = &[
    ".mobile-topbar-header-sign-in-button",
    "ytm-comments-entry-point-header-renderer",
    "ytm-item-section-renderer.single-column-watch-next-modern-panels",
    "#comments",
];

/// The elements to hide on a page for the chosen clean-up: YouTube's own, and none on other sites.
#[uniffi::export]
pub fn youtube_selectors(cleanup: YouTubeCleanup, url: String) -> Vec<String> {
    let host = host_of(&url);
    if !matches!(
        host.as_str(),
        "youtube.com" | "www.youtube.com" | "m.youtube.com"
    ) {
        return Vec::new();
    }
    [
        (cleanup.shorts, SHORTS),
        (cleanup.suggestions, SUGGESTIONS),
        (cleanup.distractions, DISTRACTIONS),
    ]
    .into_iter()
    .filter(|(on, _)| *on)
    .flat_map(|(_, rules)| rules.iter().map(|rule| (*rule).to_owned()))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cleanup(shorts: bool, suggestions: bool, distractions: bool) -> YouTubeCleanup {
        YouTubeCleanup {
            shorts,
            suggestions,
            distractions,
        }
    }

    #[test]
    fn hides_the_chosen_groups_on_youtube() {
        let rules = youtube_selectors(cleanup(true, false, true), "https://m.youtube.com/".into());
        assert_eq!(rules.len(), SHORTS.len() + DISTRACTIONS.len());
        assert!(rules.contains(&"ytm-reel-shelf-renderer".to_owned()));
        assert!(rules.contains(&"#comments".to_owned()));
        assert!(!rules.contains(&"#related".to_owned()));
    }

    #[test]
    fn hides_nothing_elsewhere_or_when_off() {
        assert!(
            youtube_selectors(cleanup(true, true, true), "https://notyoutube.com/".into())
                .is_empty()
        );
        assert!(
            youtube_selectors(
                cleanup(true, true, true),
                "https://music.youtube.com/".into()
            )
            .is_empty()
        );
        assert!(
            youtube_selectors(
                cleanup(false, false, false),
                "https://www.youtube.com/watch?v=x".into()
            )
            .is_empty()
        );
    }
}
