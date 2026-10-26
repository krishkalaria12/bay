import { hostOf, type SearchScope } from "@bay/core";
import type { BrowserState } from "../../store/browser";
import { isLightColor } from "../../lib/windowTint";

export type ScopeColors = { background: string; text: string };

// Recognizable site accents, including when the site has not been opened yet.
const SITE_COLORS: Record<string, string> = {
  "youtube.com": "#D90000",
  "google.com": "#1967D2",
  "wikipedia.org": "#54595D",
  "github.com": "#24292F",
  "amazon.com": "#FF9900",
  "reddit.com": "#D93900",
  "twitter.com": "#006BB3",
  "x.com": "#242424",
  "spotify.com": "#1DB954",
  "stackoverflow.com": "#D95600",
  "npmjs.com": "#CB3837",
  "duckduckgo.com": "#C9442C",
  "bing.com": "#007D83",
  "notion.so": "#37352F",
  "figma.com": "#A259FF",
};

const normalizedHost = (url: string) => hostOf(url).replace(/^www\./, "");

export function scopeColorFor(scope: SearchScope | null, state: Pick<BrowserState, "tabs" | "live">, spaceId: string): string | null {
  if (!scope || scope.kind === "history") return null;
  const host = normalizedHost(scope.url);
  if (!host) return null;
  for (const site in SITE_COLORS) if (host === site || host.endsWith(`.${site}`)) return SITE_COLORS[site]!;
  // Reuse a custom site's page color in this profile, without opening or fetching the site.
  for (const id in state.tabs) {
    const tab = state.tabs[id]!;
    const color = state.live[id]?.themeColor;
    if (tab.spaceId === spaceId && normalizedHost(tab.url) === host && color && /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(color)) return color.slice(0, 7);
  }
  return null;
}

export function scopeColorsFor(color: string | null): ScopeColors | null {
  return color ? { background: color, text: isLightColor(color) ? "#000000" : "#FFFFFF" } : null;
}
