import { APP_NAME } from "../../lib/constants";
import type { SettingsPane } from "./windows";

// The sidebar's search looks inside the panes too: each setting by its row's (or section's) title as the pane shows
// it, so choosing one can find and mark that row (controls.tsx's useSearchHighlight), and a few words it goes by.
export type SettingEntry = { pane: SettingsPane; title: string; words?: string };

const SETTINGS: SettingEntry[] = [
  { pane: "general", title: `Open ${APP_NAME} at login`, words: "startup launch" },
  { pane: "general", title: "Warn before quitting", words: "cmd q confirm" },
  { pane: "general", title: "Warn before closing a window with multiple tabs", words: "confirm" },
  { pane: "general", title: "Start on", words: "launch startup open new tab last tab blank restore" },
  { pane: "general", title: "Windows and tabs", words: "quit restore session preserve start fresh" },
  { pane: "general", title: "When input looks like a website", words: "command bar search url" },
  { pane: "general", title: "Check for updates automatically", words: "updates" },
  { pane: "general", title: `Automatically update ${APP_NAME}`, words: "updates install" },
  { pane: "general", title: "Import from another browser", words: "chrome arc safari firefox bookmarks passwords history" },

  { pane: "search", title: "Default search engine", words: "google duckduckgo bing custom" },
  { pane: "search", title: "Show search suggestions", words: "autocomplete" },

  { pane: "appearance", title: "Appearance Theme", words: "dark light mode" },
  { pane: "appearance", title: "Window", words: "solid glass transparent material background" },
  { pane: "appearance", title: "Sidebar", words: "left right position side" },
  { pane: "appearance", title: "Address Bar", words: "url toolbar location" },
  { pane: "appearance", title: "App Icon", words: "dock" },

  { pane: "tabs", title: "Tab layout", words: "sidebar top vertical horizontal" },
  { pane: "tabs", title: "Hide toolbar while scrolling", words: "auto hide" },
  { pane: "tabs", title: "Add new tabs to the top", words: "position order bottom" },
  { pane: "tabs", title: "Warn before closing last tab in a Space", words: "confirm" },
  { pane: "tabs", title: "Haptic feedback when reordering tabs", words: "trackpad drag" },
  { pane: "tabs", title: "Extend website color into tab bar", words: "colour tint" },
  { pane: "tabs", title: "Automatic Picture in Picture", words: "pip video call" },
  { pane: "tabs", title: "Automatically group tabs for meetings", words: "tab groups" },
  { pane: "tabs", title: "Always keep these sites awake", words: "sleep memory idle whatsapp telegram slack discord gmail spotify" },
  { pane: "tabs", title: "Previews", words: "hover folders groups gmail github calendar" },
  { pane: "tabs", title: "Clean up", words: "archive inactive close unused tabs" },

  { pane: "sync", title: "Sync folder", words: "icloud drive" },
  { pane: "sync", title: "What Syncs", words: "bookmarks history passwords" },
  { pane: "sync", title: "Devices", words: "mac connect" },

  { pane: "spaces", title: "Default space", words: "new windows profile" },

  { pane: "links", title: "Links from other apps", words: "little bay discord slack mail default" },
  { pane: "links", title: "Open a Peek window when clicking links to other sites", words: "peek pinned favorites" },
  { pane: "links", title: "⌘-clicking links creates tab groups", words: "cmd command click" },
  { pane: "links", title: "⌥⇧-click opens tab in group", words: "option shift click split" },

  { pane: "passwords", title: "Import passwords", words: "csv" },
  { pane: "passwords", title: "Export passwords", words: "csv" },
  { pane: "passwords", title: "Password manager apps", words: "1password bitwarden" },

  { pane: "autofill", title: "Save and fill addresses", words: "names email phone forms" },
  { pane: "autofill", title: "Save and fill credit cards", words: "payment" },

  { pane: "privacy", title: "Block ads", words: "ad blocker content" },
  { pane: "privacy", title: "Block trackers", words: "tracking content" },
  { pane: "privacy", title: "Block cookie banners", words: "content" },
  { pane: "privacy", title: "Advanced Settings", words: "filter lists easylist content blocking" },
  { pane: "privacy", title: "Site permissions", words: "camera microphone location pop-ups notifications" },
  { pane: "privacy", title: "Apps allowed to open links", words: "external" },
  { pane: "privacy", title: "Zoom levels", words: "sites" },
  { pane: "privacy", title: "Crash reports and usage", words: "diagnostics analytics telemetry" },

  { pane: "extensions", title: "Chrome Web Store", words: "add install" },
  { pane: "extensions", title: "Add from a link", words: "install id" },
  { pane: "extensions", title: "Load unpacked extension", words: "developer folder manifest" },

  { pane: "calendar", title: "Calendar access", words: "connect" },
  { pane: "calendar", title: "Show next meeting alert", words: "notification" },
  { pane: "calendar", title: "Show alerts", words: "notification center" },
  { pane: "calendar", title: "Show calendar preview", words: "hover pinned" },
  { pane: "calendar", title: "Show time to next meeting", words: "badge countdown" },

  { pane: "advanced", title: "Show full URL in the address bar", words: "address" },
  { pane: "advanced", title: "Warn before moving tabs between spaces", words: "confirm" },
  { pane: "advanced", title: "Show the Import bookmarks button", words: "bookmarks bar" },
  { pane: "advanced", title: "Battery Saver", words: "energy power performance" },
  { pane: "advanced", title: "History", words: "visited pages" },
  { pane: "advanced", title: "Downloads", words: "files" },
  { pane: "advanced", title: "Chromium", words: "web engine version" },

  { pane: "liveFolders", title: "Live folders", words: "refresh" },
];

// Typing a lot of the alphabet shouldn't list half the settings: a handful, best first.
const MAX_RESULTS = 6;

const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}⌘⌥⇧]+/u)
    .filter(Boolean);

/** The settings whose words start with each of the query's: titles that start with it first, then titles that have
 *  it, then the rest. */
export function findSettings(query: string): SettingEntry[] {
  if (query.trim().length < 2) return [];
  const terms = wordsOf(query);
  if (!terms.length) return [];
  const has = (words: string[]) => terms.every((t) => words.some((w) => w.startsWith(t)));
  const scoreOf = (title: string[]) => {
    if (title[0]?.startsWith(terms[0]!)) return 0;
    if (has(title)) return 1;
    return 2;
  };
  const scored: { entry: SettingEntry; score: number }[] = [];
  for (const entry of SETTINGS) {
    const title = wordsOf(entry.title);
    if (has([...title, ...wordsOf(entry.words ?? "")])) scored.push({ entry, score: scoreOf(title) });
  }
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_RESULTS)
    .map((s) => s.entry);
}
