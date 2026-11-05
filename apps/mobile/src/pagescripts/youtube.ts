import type { YouTubeCleanup } from "../store/types.ts";

// From Brave's YouTube lists (github.com/brave/adblock-lists, brave-lists/yt-*.txt, MPL-2.0): the plain CSS rules for
// youtube.com and m.youtube.com.
const RULES: Record<keyof YouTubeCleanup, readonly string[]> = {
  shorts: [
    "ytm-reel-shelf-renderer",
    "ytm-shorts-lockup-view-model-v2",
    ".big-shorts-singleton",
    ".pivot-shorts.pivot-bar-item-tab",
    'ytm-media-item:has(a[href^="/shorts/"])',
    '.ytLockupViewModelWrapper:has(a[href^="/shorts/"])',
    '.media-item-thumbnail-container[aria-hidden][href^="/shorts/"]',
    'ytd-rich-section-renderer:has(a[href^="/shorts/"])',
    'ytd-reel-shelf-renderer:has(a[href^="/shorts/"])',
    '.yt-simple-endpoint[title="Shorts"]',
    ".ytGridShelfViewModelHost",
  ],
  suggestions: ['ytm-item-section-renderer[section-identifier="related-items"]', ".ytm-player-endscreen", "#related", ".ytp-endscreen-content"],
  distractions: [
    ".mobile-topbar-header-sign-in-button",
    "ytm-comments-entry-point-header-renderer",
    "ytm-item-section-renderer.single-column-watch-next-modern-panels",
    "#comments",
  ],
};

/** The rules to hide on a YouTube page for the chosen cleanup; none on other sites. */
export function youtubeSelectors(cleanup: YouTubeCleanup, host: string): string[] {
  if (!/^(www\.|m\.)?youtube\.com$/.test(host)) return [];
  return (Object.keys(RULES) as (keyof YouTubeCleanup)[]).flatMap((key) => (cleanup[key] ? RULES[key] : []));
}
