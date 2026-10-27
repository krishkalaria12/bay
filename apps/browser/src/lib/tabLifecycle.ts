import { listTasks, onSystemState, releaseProfile, systemState, type SystemState, type WebViewHandle } from "@bay/nncore";
import { onAppEvent, onWindowEvent } from "@bay/shell";
import { create } from "zustand";
import { pageOf } from "../components/layout/pageState";
import { useMedia } from "../components/media/state";
import { isInternalTab } from "../components/pages";
import { useBrowser, type BrowserState } from "../store/browser";
import { activeTabId, engineProfile, inPinnedContainer, isIncognitoSpace, wake } from "../store/model";
import { shownPeek } from "../store/peeks";
import { splitOf } from "../store/splits";
import { applyHeldReports } from "./nativeEvents";
import { everySlowly } from "./slowTimers";
import { webviews } from "./webviews";
import { LIFECYCLE_EVAL_TIMEOUT_MS, LIFECYCLE_SWEEP_MS } from "./constants";
import { siteKeptAwake } from "./awakeSites";

export const POLICY = {
  protectedRecent: 10,
  idleMs: 2 * 60 * 60_000,
  profileIdleMs: 2 * 60 * 60_000,
  perSweep: 6,
};

type Lifecycle = {
  discarded: Record<string, true>;
};

export const useLifecycle = create<Lifecycle>()(() => ({ discarded: {} }));

export const useIsSleeping = (tabId: string) => useLifecycle((l) => !!l.discarded[tabId]);

const store = () => useBrowser.getState();

let appActive = true;
let activeSince = Date.now();
let activeTotal = 0;
const activeClock = () => activeTotal + (appActive ? Date.now() - activeSince : 0);
function setAppActive(active: boolean) {
  if (active === appActive) return;
  if (appActive) activeTotal += Date.now() - activeSince;
  else activeSince = Date.now();
  appActive = active;
}

const hiddenAt = new Map<string, number>();
const unusedSince = new Map<string, number>();
const loadedProfiles = new Set<string>();

let system: SystemState | null = null;
let systemOverride: Partial<SystemState> | null = null;
const currentSystem = () => (system ? { ...system, ...systemOverride } : null);

function shownTabIds(s: BrowserState): Set<string> {
  const shown = new Set<string>();
  for (const w of Object.values(s.windows)) {
    const id = activeTabId(s, w.id);
    if (!id) continue;
    shown.add(id);
    for (const pane of splitOf(s, id)?.tabIds ?? []) shown.add(pane);
    // A peek over the page is on screen too.
    const peek = shownPeek(s, w.id);
    if (peek) shown.add(peek.tabId);
  }
  return shown;
}

const loadedTabIds = () => [...webviews.keys()].filter((id) => !useLifecycle.getState().discarded[id]);

export function keepAliveReason(s: BrowserState, id: string): string | null {
  const tab = s.tabs[id];
  if (!tab?.url || isInternalTab(tab)) return "no page";
  const live = s.live[id];
  if (live?.playingAudio) return "playing audio";
  if (live?.isLoading) return "loading";
  const page = pageOf(id);
  if (page.mediaAccess) return "capturing";
  if (page.permission) return "asking for permission";
  if (page.newTabShown) return "kept for Forward";
  const media = useMedia.getState();
  if (media.pipOpen[id]) return "picture in picture";
  if (media.displayRequests[id]) return "choosing a screen to share";
  const session = media.sessions[id];
  if (session?.playbackState === "playing" || (tab.pinned && session)) return "media";
  if (splitOf(s, id)) return "in a split";
  return null;
}

const UNSAVED_INPUT_CHECK = `
const notText = new Set(["hidden", "submit", "button", "reset", "image", "search", "checkbox", "radio", "range", "color"]);
const dirty = (doc) => {
  for (const el of doc.querySelectorAll("input, textarea")) {
    if (el.disabled || el.readOnly) continue;
    if (el.type === "file") {
      if (el.files && el.files.length) return true;
    } else if (!notText.has(el.type) && el.value && el.value !== el.defaultValue) {
      return true;
    }
  }
  const active = doc.activeElement;
  return !!(active && active.isContentEditable && active.textContent.trim());
};
let unsaved = typeof window.onbeforeunload === "function" || dirty(document);
for (let i = 0; !unsaved && i < frames.length; i++) {
  try { unsaved = typeof frames[i].onbeforeunload === "function" || dirty(frames[i].document); } catch (e) {}
}
post("result", JSON.stringify(unsaved));`;

const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T) =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

async function hasUnsavedInput(handle: WebViewHandle): Promise<boolean | null> {
  const result = await withTimeout(
    handle.evaluate<boolean>(UNSAVED_INPUT_CHECK).catch(() => null),
    LIFECYCLE_EVAL_TIMEOUT_MS,
    null,
  );
  return typeof result === "boolean" ? result : null;
}

export async function sleepTab(id: string, automatic = false): Promise<boolean> {
  const handle = webviews.get(id);
  if (!handle || useLifecycle.getState().discarded[id]) return false;
  // Asked now, never remembered: a page can be shown and typed in at any moment before this.
  if ((await hasUnsavedInput(handle)) !== false) return false;
  // The page's reports that came while we waited (audio, loading, capture) count.
  applyHeldReports();
  const s = store();
  if (shownTabIds(s).has(id) || keepAliveReason(s, id) || webviews.get(id) !== handle) return false;
  if (
    automatic &&
    (s.tabs[id]?.kept || inPinnedContainer(s, id) || (currentSystem()?.memoryPressure !== "critical" && siteKeptAwake(s.tabs[id]?.url, s.settings.awakeSites)))
  )
    return false;
  // Only what Chrome did counts, and its onDiscarded records it (a later onReady, the tab woken, clears it): a refusal
  // leaves the tab awake.
  return (await handle.discard()) === "discarded";
}

// MARK: Web view events (ContentCard)

export function noteReady(tabId: string) {
  const tab = store().tabs[tabId];
  if (tab) loadedProfiles.add(engineProfile(tab.spaceId));
  forget(tabId, false);
}

export function noteDiscarded(tabId: string) {
  useLifecycle.setState((l) => ({ discarded: { ...l.discarded, [tabId]: true } }));
}

export function noteGone(tabId: string) {
  forget(tabId, true);
}

function forget(tabId: string, all: boolean) {
  if (all) hiddenAt.delete(tabId);
  const l = useLifecycle.getState();
  if (l.discarded[tabId]) useLifecycle.setState({ discarded: omit(l.discarded, tabId) });
}

function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

// MARK: Sleeping tabs and unloading profiles

let sweeping = false;

export async function sweep(overrides: Partial<typeof POLICY> = {}): Promise<string[]> {
  if (sweeping) return [];
  sweeping = true;
  const slept: string[] = [];
  try {
    const policy = { ...POLICY, ...overrides };
    const s = store();
    const shown = shownTabIds(s);
    const now = activeClock();
    const pressure = currentSystem()?.memoryPressure ?? "normal";
    const recent = new Set(
      Object.values(s.tabs)
        .filter((t) => t.url)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .slice(0, pressure === "critical" ? 0 : policy.protectedRecent)
        .map((t) => t.id),
    );
    const unused = unusedProfiles(s, now, policy.profileIdleMs);
    const candidates = [...webviews.keys()].filter((id) => {
      const tab = s.tabs[id];
      // A kept tab sleeps only when asked (the tab menu's Put Tab to Sleep).
      if (!tab || tab.kept || inPinnedContainer(s, id) || shown.has(id) || useLifecycle.getState().discarded[id]) return false;
      if (pressure !== "critical" && siteKeptAwake(tab.url, s.settings.awakeSites)) return false;
      const idle = now - (hiddenAt.get(id) ?? now);
      if (!unused.has(tab.spaceId) && (recent.has(id) || (pressure === "normal" && idle < policy.idleMs))) return false;
      return !keepAliveReason(s, id);
    });
    candidates.sort(
      (a, b) =>
        Number(siteKeptAwake(s.tabs[a]?.url, s.settings.awakeSites)) - Number(siteKeptAwake(s.tabs[b]?.url, s.settings.awakeSites)) ||
        (hiddenAt.get(a) ?? now) - (hiddenAt.get(b) ?? now),
    );
    for (const id of candidates) {
      if (slept.length >= policy.perSweep) break;
      if (await sleepTab(id, true)) slept.push(id);
    }
    releaseUnusedProfiles();
  } finally {
    sweeping = false;
  }
  return slept;
}

function unusedProfiles(s: BrowserState, now: number, idleMs: number): Set<string> {
  const shownProfiles = new Set(Object.values(s.windows).map((w) => w.spaceId));
  const unused = new Set<string>();
  for (const id of Object.keys(s.spaces)) {
    if (shownProfiles.has(id)) {
      unusedSince.delete(id);
      continue;
    }
    if (!unusedSince.has(id)) unusedSince.set(id, now);
    if (now - unusedSince.get(id)! >= idleMs) unused.add(id);
  }
  for (const id of unusedSince.keys()) if (!s.spaces[id]) unusedSince.delete(id);
  return unused;
}

function releaseUnusedProfiles() {
  const s = store();
  const inUse = new Set(Object.values(s.windows).map((w) => engineProfile(w.spaceId)));
  for (const id of webviews.keys()) {
    const tab = s.tabs[id];
    if (tab) inUse.add(engineProfile(tab.spaceId));
  }
  for (const profile of Array.from(loadedProfiles)) {
    if (!profile || isIncognitoSpace(profile) || inUse.has(profile)) continue;
    loadedProfiles.delete(profile);
    void releaseProfile(profile);
  }
}

// MARK: Launch

export function reloadRecentTabs(sys: SystemState) {
  const gb = sys.physicalMemory / 2 ** 30;
  const busy = sys.onBattery || sys.lowPowerMode || sys.memoryPressure !== "normal";
  const count = busy ? 0 : gb >= 32 ? 4 : gb >= 16 ? 3 : gb >= 8 ? 1 : 0;
  const s = store();
  const shown = shownTabIds(s);
  const since = Date.now() - 24 * 60 * 60_000;
  const ids = Object.values(s.tabs)
    .filter((t) => t.url && !t.navigation && !t.adoptId && !t.unloaded && !shown.has(t.id) && !isInternalTab(t) && t.lastActiveAt >= since)
    .filter((t) => s.windows[t.windowId]?.spaceId === t.spaceId)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, count)
    .map((t) => t.id);
  ids.forEach((id, i) =>
    setTimeout(
      () => {
        const t = store().tabs[id];
        if (t?.url && !t.navigation && !t.adoptId) store().updateTab(id, wake(t));
      },
      2000 * (i + 1),
    ),
  );
  return ids;
}

// MARK: Start

let started = false;

export function startTabLifecycle() {
  if (started) return;
  started = true;

  onWindowEvent((e) => e.type === "focus" && setAppActive(true));
  onAppEvent((e) => (e.type === "resignActive" || e.type === "screenLocked") && setAppActive(false));

  let lastShown = new Set<string>();
  const track = (s: BrowserState) => {
    const shown = shownTabIds(s);
    const now = activeClock();
    for (const id of lastShown) if (!shown.has(id)) hiddenAt.set(id, now);
    for (const id of shown) hiddenAt.delete(id);
    for (const id of webviews.keys()) if (!shown.has(id) && !hiddenAt.has(id)) hiddenAt.set(id, now);
    lastShown = shown;
  };
  track(store());
  useBrowser.subscribe((s, prev) => {
    if (s.windows !== prev.windows || s.splits !== prev.splits) track(s);
  });

  const onSystem = (state: SystemState) => {
    const pressureRose = state.memoryPressure !== "normal" && state.memoryPressure !== system?.memoryPressure;
    system = state;
    if (pressureRose) void sweep();
  };
  void Promise.resolve()
    .then(systemState)
    .then(
      (state) => {
        system = state;
        onSystemState(onSystem);
        setTimeout(() => reloadRecentTabs(currentSystem()!), 3000);
      },
      () => {},
    );

  everySlowly({
    every: LIFECYCLE_SWEEP_MS,
    run: () => {
      track(store());
      void sweep();
    },
  });

  if (__DEV__) {
    (globalThis as { nnLifecycle?: unknown }).nnLifecycle = {
      policy: POLICY,
      sweep,
      sleepTab,
      reloadRecentTabs,
      state: () => ({
        ...useLifecycle.getState(),
        system: currentSystem(),
        appActive,
        activeClock: activeClock(),
        hiddenAt: Object.fromEntries(hiddenAt),
        loadedProfiles: [...loadedProfiles],
        loaded: loadedTabIds(),
      }),
      keepAliveReason: (id: string) => keepAliveReason(store(), id),
      memory: () =>
        listTasks()
          .then(() => new Promise((resolve) => setTimeout(resolve, 2500)))
          .then(listTasks)
          .then((tasks) => {
            const byType: Record<string, number> = {};
            const seen = new Set<string>();
            for (const t of tasks) {
              const key = t.browserIds.length ? `${t.type}:${t.memory}` : `${t.id}`;
              if (t.memory < 0 || seen.has(key)) continue;
              seen.add(key);
              byType[t.type] = (byType[t.type] ?? 0) + t.memory / 2 ** 20;
            }
            const total = Object.values(byType).reduce((a, b) => a + b, 0);
            return {
              totalMB: Math.round(total),
              byTypeMB: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, Math.round(v)])),
              tasks: tasks.length,
            };
          }),
      simulate: (patch: Partial<SystemState> | null) => {
        systemOverride = patch;
      },
    };
  }
}
