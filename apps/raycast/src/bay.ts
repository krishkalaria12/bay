// Bay from Raycast: its AppleScript dictionary (apps/browser/macos/Bay-macOS/Bay.sdef) for windows, tabs and spaces
// (profiles), and the bay command for history, which AppleScript doesn't reach. Private windows are left out, and no
// site icon is fetched: a favicon service would see every tab's host.
import { getPreferenceValues } from "@raycast/api";
import { runAppleScript } from "@raycast/utils";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseHistory, parseSpaces, parseTabs, type BaySpace, type BayTab, type Visit } from "./parse";

const jxa = (script: string, args: string[] = []) => runAppleScript(script, args, { language: "JavaScript", timeout: 15_000 });

// Every tab of every window but private ones, with its window, its space and whether it's selected.
const TABS = `function run() {
  const bay = Application("Bay");
  if (!bay.running()) return "[]";
  const out = [];
  for (const w of bay.windows()) {
    if (w.incognito()) continue;
    const profile = w.activeProfile();
    const space = profile ? profile.name() : "";
    for (const t of w.tabs()) out.push({ windowId: w.id(), id: t.id(), title: t.title(), url: t.url(), pinned: t.isPinned(), focused: t.isFocused(), space });
  }
  return JSON.stringify(out);
}`;

const SPACES = `function run() {
  const bay = Application("Bay");
  if (!bay.running()) return "[]";
  const front = bay.windows().find((w) => !w.incognito());
  const shown = front && front.activeProfile() ? front.activeProfile().id() : "";
  return JSON.stringify(bay.profiles().map((p) => ({ id: p.id(), name: p.name(), index: p.index(), shown: p.id() === shown })));
}`;

const FOCUS_TAB = `function run(argv) {
  const bay = Application("Bay");
  bay.focus(bay.windows.byId(argv[0]).tabs.byId(argv[1]));
  bay.activate();
}`;

const FOCUS_SPACE = `function run(argv) {
  const bay = Application("Bay");
  bay.focus(bay.profiles.byId(argv[0]));
  bay.activate();
}`;

// A new tab in the front window (the New Tab page without an address), or a new window.
const NEW_TAB = `function run(argv) {
  const bay = Application("Bay");
  bay.activate();
  const tab = argv[0] ? bay.make({ new: "tab", withProperties: { url: argv[0] } }) : bay.make({ new: "tab" });
  if (tab) bay.focus(tab);
}`;

const NEW_WINDOW = `function run() {
  const bay = Application("Bay");
  bay.activate();
  bay.make({ new: "window" });
}`;

export const listTabs = async (): Promise<BayTab[]> => parseTabs(await jxa(TABS));

export const listSpaces = async (): Promise<BaySpace[]> => parseSpaces(await jxa(SPACES));

export const focusTab = (tab: BayTab) => jxa(FOCUS_TAB, [tab.windowId, tab.id]);

export const focusSpace = (space: BaySpace) => jxa(FOCUS_SPACE, [space.id]);

export const newTab = (url = "") => jxa(NEW_TAB, [url]);

export const newWindow = () => jxa(NEW_WINDOW);

// MARK: History, through the bay command

/** The bay command: the one in Preferences, else where Bay's installer and package managers put it. */
export function bayCommand(): string | null {
  const { bayCommand: chosen } = getPreferenceValues<{ bayCommand?: string }>();

  if (chosen?.trim()) return chosen.trim().replace(/^~(?=\/)/, homedir());
  const places = [join(homedir(), ".local/bin/bay"), "/usr/local/bin/bay", "/opt/homebrew/bin/bay"];

  return places.find((place) => existsSync(place)) ?? null;
}

export class NoBayCommand extends Error {}

/** The last month's pages, most recent first; the bay command reads them from Bay's own history. */
export function searchHistory(days = 30, limit = 1000): Promise<Visit[]> {
  const command = bayCommand();

  if (!command) return Promise.reject(new NoBayCommand("Install the bay command from Bay's Settings › Advanced."));

  return new Promise((resolve, reject) => {
    execFile(
      command,
      ["exec", "--json", `await history({ days: ${days}, limit: ${limit} })`],
      { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim().split("\n").at(-1) || error.message));
        else resolve(parseHistory(stdout));
      },
    );
  });
}
