import { setBoosts as setEngineBoosts, type EngineBoostStyle } from "@bay/nncore";
import { readDocument, writeDocument } from "@bay/shell";
import { create } from "zustand";
import { hasServiceClient } from "../../runtime/serviceClient";
import { engineBoosts, newBoost, normalizeBoost, normalizeScript, tabBoostStyle, type Boost, type BoostPalette, type BoostScript } from "../../lib/boosts";
import { hex, SPACE_COLORS, spaceThemeKey, themeFor } from "../../lib/theme";
import { onWebviewAttached, webviews } from "../../lib/webviews";
import { useBrowserRead as useBrowser } from "../../store/read";
import type { BrowserProjection } from "../../runtime/projection";
import { newId } from "../../store/model";
import { DEFAULT_SPACE } from "../../store/spaces";

// Boosts' store: every Boost (synced: sync/boosts.ts), this Mac's scripts (never synced), and Boosts' own switch.
// Saved to boosts.json; every change reaches the engine, which restyles the pages it shows at once.

export type BoostsState = {
  loaded: boolean;
  error: string | null;
  // All Boosts on or off (Settings › Boosts): this Mac's.
  on: boolean;
  boosts: Record<string, Boost>;
  scripts: Record<string, BoostScript>;
  // The warning for a first JavaScript Boost was read.
  scriptsAcknowledged: boolean;
};

const FILE = "boosts.json";

export const useBoosts = create<BoostsState>()(() => ({ loaded: false, error: null, on: true, boosts: {}, scripts: {}, scriptsAcknowledged: false }));

let loaded = false;
let started = false;

/** Sync loads persisted data without starting page-style observers or timers. */
export function ensureBoostsLoaded() {
  if (hasServiceClient() || loaded) return;
  loaded = true;
  load();
  useBoosts.subscribe((s, prev) => {
    if (!s.loaded || s.error) return;
    if (s.boosts !== prev.boosts || s.scripts !== prev.scripts || s.on !== prev.on || s.scriptsAcknowledged !== prev.scriptsAcknowledged) save(s);
  });
}

export const boostsAvailable = () => !hasServiceClient();

export function startBoosts() {
  if (!boostsAvailable() || started) return;
  started = true;
  ensureBoostsLoaded();
  useBoosts.subscribe((s, prev) => {
    if (s.boosts !== prev.boosts || s.scripts !== prev.scripts || s.on !== prev.on) {
      scheduleEngine();
      scheduleTabs();
    }
  });
  // Pages move between sites and spaces change colour: tabs' sheets follow.
  useBrowser.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs || s.spaces !== prev.spaces || s.ui.appDark !== prev.ui.appDark) scheduleTabs();
  });
  onWebviewAttached((tabId, handle) => {
    if (hasServiceClient()) return;
    const browser = useBrowser.getState();
    const tab = browser.tabs[tabId];
    if (!tab) return;
    const boosts = useBoosts.getState();
    const style = tabBoostStyle(spacePalette(browser, tab.spaceId), Object.values(boosts.boosts), boosts.on);
    sentStyles.set(tabId, JSON.stringify(style));
    void handle.setBoostStyle(style);
  });
  pushEngine();
  scheduleTabs();
}

function load() {
  try {
    const json = readDocument(FILE);
    const data = json ? (JSON.parse(json) as Record<string, unknown>) : {};
    const boosts: Record<string, Boost> = {};
    for (const raw of Object.values((data.boosts as Record<string, unknown>) ?? {})) {
      const b = normalizeBoost(raw);
      if (b) boosts[b.id] = b;
    }
    const scripts: Record<string, BoostScript> = {};
    for (const [id, raw] of Object.entries((data.scripts as Record<string, unknown>) ?? {})) {
      const script = normalizeScript(raw);
      if (script && boosts[id]) scripts[id] = script;
    }
    useBoosts.setState({ loaded: true, error: null, on: data.on !== false, boosts, scripts, scriptsAcknowledged: data.scriptsAcknowledged === true });
  } catch (error) {
    // An unreadable file is kept as it is, not overwritten: nothing is saved until it's fixed.
    useBoosts.setState({ loaded: true, error: `Couldn't read Boosts: ${String(error)}` });
  }
}

function save(s: BoostsState) {
  if (hasServiceClient()) return;
  try {
    writeDocument(FILE, JSON.stringify({ version: 1, on: s.on, boosts: s.boosts, scripts: s.scripts, scriptsAcknowledged: s.scriptsAcknowledged }));
  } catch (error) {
    console.warn("Couldn't save Boosts", error);
  }
}

// MARK: The engine

let engineTimer: ReturnType<typeof setTimeout> | null = null;
let lastEngine = "";

// Typing in the CSS field changes a Boost many times a second: the engine takes the latest a moment later.
function scheduleEngine() {
  if (hasServiceClient()) return;
  if (engineTimer) return;
  engineTimer = setTimeout(() => {
    engineTimer = null;
    pushEngine();
  }, 60);
}

function pushEngine() {
  if (hasServiceClient()) return;
  const s = useBoosts.getState();
  if (!s.loaded) return;
  const list = engineBoosts(Object.values(s.boosts), s.scripts, s.on);
  const json = JSON.stringify(list);
  if (json === lastEngine) return;
  lastEngine = json;
  void setEngineBoosts(list);
}

// MARK: Tabs' sheets

const sentStyles = new Map<string, string>();
let tabsTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleTabs() {
  if (hasServiceClient()) return;
  if (tabsTimer) return;
  tabsTimer = setTimeout(() => {
    tabsTimer = null;
    pushTabs();
  }, 80);
}

/** A space's palette for Boosts: its window's colours and text in the current appearance. */
export function spacePalette(s: BrowserProjection, spaceId: string): BoostPalette {
  const space = s.spaces[spaceId] ?? DEFAULT_SPACE;
  const theme = themeFor(spaceThemeKey(space, s.ui.appDark));
  const colors = space.theme?.colors.length ? space.theme.colors : [(SPACE_COLORS[space.color] ?? SPACE_COLORS.plum).swatch.slice(0, 7)];
  return {
    background: hex(theme.windowTint[0]),
    backgroundExtra: hex(theme.windowTint[1]),
    foreground: hex(theme.textPrimary),
    foregroundSecondary: hex(theme.textSecondary),
    foregroundTertiary: hex(theme.textTertiary),
    accent: hex(theme.powerUpColor ?? theme.accent),
    hover: hex(theme.tabHover),
    colors: [...colors],
  };
}

function pushTabs() {
  if (hasServiceClient()) return;
  const boosts = useBoosts.getState();
  const s = useBrowser.getState();
  const styles = new Map<string, { style: EngineBoostStyle; json: string }>();
  for (const [tabId, tab] of Object.entries(s.tabs)) {
    let entry = styles.get(tab.spaceId);
    if (!entry) {
      const style = tabBoostStyle(spacePalette(s, tab.spaceId), Object.values(boosts.boosts), boosts.on);
      entry = { style, json: JSON.stringify(style) };
      styles.set(tab.spaceId, entry);
    }
    if (sentStyles.get(tabId) === entry.json) continue;
    sentStyles.set(tabId, entry.json);
    void webviews.get(tabId)?.setBoostStyle(entry.style);
  }
  for (const tabId of sentStyles.keys()) if (!s.tabs[tabId]) sentStyles.delete(tabId);
}

// MARK: Editing

export const boostsForHost = (s: BoostsState, host: string) =>
  Object.values(s.boosts)
    .filter((b) => b.host === host)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

/** A new Boost for a site, on; null when Boosts can't be saved. */
export function createBoost(host: string, name?: string): Boost | null {
  if (!boostsAvailable()) return null;
  startBoosts();
  const s = useBoosts.getState();
  if (s.error || !host) return null;
  const count = boostsForHost(s, host).length;
  const boost = newBoost(newId("boost"), host, Date.now(), name ?? (count ? `My Boost ${count + 1}` : "My Boost"));
  useBoosts.setState({ boosts: { ...s.boosts, [boost.id]: boost } });
  return boost;
}

/** Adds a Boost made elsewhere (an import), with its script off. */
export function addBoost(boost: Boost, script = "") {
  if (!boostsAvailable()) return;
  const s = useBoosts.getState();
  if (s.error) return;
  useBoosts.setState({
    boosts: { ...s.boosts, [boost.id]: boost },
    ...(script ? { scripts: { ...s.scripts, [boost.id]: { code: script, enabled: false, privateWindows: false } } } : {}),
  });
}

export function updateBoost(id: string, patch: Partial<Omit<Boost, "id" | "host" | "createdAt">> | ((b: Boost) => Partial<Boost>)) {
  const s = useBoosts.getState();
  const before = s.boosts[id];
  if (!boostsAvailable() || !before || s.error) return;
  const next = normalizeBoost({ ...before, ...(typeof patch === "function" ? patch(before) : patch), id, host: before.host, updatedAt: Date.now() });
  if (next) useBoosts.setState({ boosts: { ...s.boosts, [id]: next } });
}

export function deleteBoost(id: string) {
  if (!boostsAvailable()) return;
  const s = useBoosts.getState();
  if (!s.boosts[id] || s.error) return;
  const boosts = { ...s.boosts };
  const scripts = { ...s.scripts };
  delete boosts[id];
  delete scripts[id];
  useBoosts.setState({ boosts, scripts });
}

export function setBoostScript(id: string, patch: Partial<BoostScript>) {
  if (!boostsAvailable()) return;
  const s = useBoosts.getState();
  if (!s.boosts[id] || s.error) return;
  const before = s.scripts[id] ?? { code: "", enabled: false, privateWindows: false };
  const next = normalizeScript({ ...before, ...patch });
  if (next) useBoosts.setState({ scripts: { ...s.scripts, [id]: next } });
}

export const setBoostsOn = (on: boolean) => {
  if (boostsAvailable()) useBoosts.setState({ on });
};

export function addSelector(id: string, list: "zaps" | "focus", selector: string) {
  updateBoost(id, (b) => (b[list].includes(selector) ? {} : { [list]: [...b[list], selector] }));
}

export function removeSelector(id: string, list: "zaps" | "focus", selector: string) {
  updateBoost(id, (b) => ({ [list]: b[list].filter((s) => s !== selector) }));
}

/** Boosts synced from another Mac (sync/boosts.ts): replaces those it names, removes those it deleted. */
export function applySyncedBoosts(upserts: Boost[], removed: string[]) {
  if (!boostsAvailable()) return;
  const s = useBoosts.getState();
  if (s.error) return;
  const boosts = { ...s.boosts };
  const scripts = { ...s.scripts };
  for (const b of upserts) {
    // Consent belongs to the site where this Mac enabled the script. A synced host edit cannot transfer it.
    if (boosts[b.id]?.host !== b.host && scripts[b.id]) scripts[b.id] = { ...scripts[b.id]!, enabled: false, privateWindows: false };
    boosts[b.id] = b;
  }
  for (const id of removed) {
    delete boosts[id];
    delete scripts[id];
  }
  useBoosts.setState({ boosts, scripts });
}
