/**
 * The browsers a phone may have, and how each one's data reaches Bay. A phone's apps can't read each other's data,
 * so every way in goes through something the browser itself hands over:
 *
 * - Safari exports bookmarks and history to a file (Settings → Apps → Safari → Export).
 * - Chrome on a phone exports nothing, but Google Takeout exports what Chrome syncs: bookmarks and history.
 * - Other browsers can usually save their bookmarks as an HTML file, on the phone or on a computer.
 * - Arc Search and most browsers can share or copy a list of their open tabs.
 *
 * Passwords never come this way: Bay fills them from the phone's password manager (see the import sheet).
 */
import type { InstalledBrowser } from "@bay/mobile-import";

/** How a browser's data gets to Bay. */
export type ImportMethod = "safari" | "takeout" | "bookmarksFile" | "paste";

/** A browser on this phone, as the import sheet lists it. */
export interface PhoneBrowser {
  id: string;
  name: string;
  method: ImportMethod;
  /** The app's icon as a data URL (Android); iOS doesn't share other apps' icons. */
  icon: string | null;
}

/** The address Google Takeout opens with only Chrome chosen. */
export const TAKEOUT_URL = "https://takeout.google.com/settings/takeout/custom/chrome";

/** The browsers Bay can ask iOS about by URL scheme (app.json's LSApplicationQueriesSchemes lists these schemes). */
export const IOS_BROWSERS: readonly { url: string; id: string; name: string; method: ImportMethod }[] = [
  { url: "googlechrome://", id: "chrome", name: "Chrome", method: "takeout" },
  { url: "firefox://", id: "firefox", name: "Firefox", method: "bookmarksFile" },
  { url: "microsoft-edge-https://", id: "edge", name: "Edge", method: "bookmarksFile" },
  { url: "brave://", id: "brave", name: "Brave", method: "bookmarksFile" },
  { url: "ddgQuickLink://", id: "duckduckgo", name: "DuckDuckGo", method: "bookmarksFile" },
];

/** Safari, which every iPhone has. */
export const SAFARI: PhoneBrowser = { id: "safari", name: "Safari", method: "safari", icon: null };

/** Android packages whose data comes another way than a bookmarks file. */
const ANDROID_METHODS: readonly { pattern: RegExp; method: ImportMethod }[] = [
  // Chrome and its beta, dev and canary channels: what they sync is in Takeout.
  { pattern: /^com\.(android\.chrome|chrome\.(beta|dev|canary))$/, method: "takeout" },
  // Arc Search shares its open tabs as text.
  { pattern: /^company\.thebrowser\./, method: "paste" },
];

/** The method for an Android package. */
export function androidMethod(id: string): ImportMethod {
  return ANDROID_METHODS.find((entry) => entry.pattern.test(id))?.method ?? "bookmarksFile";
}

/** Android's browsers as the sheet lists them: the system's name and icon for each, in the order they came. */
export function androidBrowsers(installed: readonly InstalledBrowser[]): PhoneBrowser[] {
  return installed.map((app) => ({ id: app.id, name: app.name, method: androidMethod(app.id), icon: app.icon || null }));
}

/** iOS's browsers: Safari first, then each one that answered its URL scheme. */
export function iosBrowsers(answered: readonly boolean[]): PhoneBrowser[] {
  return [SAFARI, ...IOS_BROWSERS.flatMap(({ id, name, method }, index) => (answered[index] ? [{ id, name, method, icon: null }] : []))];
}
