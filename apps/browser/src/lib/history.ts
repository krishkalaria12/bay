import { addHistoryVisits, onHistoryChanged, queryHistory, watchHistory, type EngineHistoryEntry, type HistoryChange } from "@bay/nncore";
import { readDocument, removeDocument } from "@bay/shell";
import { useBrowser, type BrowserState, type BrowserStore } from "../store/browser";
import { MAX_HISTORY, MAX_VISIT_TIMES } from "../store/constants";
import { engineProfileFor, isIncognitoSpace } from "../store/model";
import type { HistoryEntry } from "../store/types";
import { CHROME_HISTORY_KEEPS_MS, HISTORY_CHUNK, LEGACY_HISTORY_FILE, LEGACY_HISTORY_KEPT_MS, LEGACY_HISTORY_TOLERANCE_MS } from "./constants";

// Keeps the store's `history` view of Chrome's history (store/history.ts): read from Chrome at launch and for
// each new profile, then kept current from Chrome's change events. Once, it moves the app's old history.json
// into Chrome.

// The pages the app's History, command bar and sync show: Chrome also keeps extension pages (a hidden helper's
// chrome-extension:// page among them), which the app never listed.
export const shownInHistory = (url: string) => /^(https?|file):/i.test(url);

const toEntry = (e: EngineHistoryEntry): HistoryEntry => ({
  url: e.url,
  title: e.title,
  favicon: null,
  visits: e.visits,
  lastVisit: e.visitTimes.length ? e.visitTimes[e.visitTimes.length - 1]! : 0,
  visitTimes: e.visitTimes,
});

// MARK: Changes

const byLastVisit = (a: HistoryEntry, b: HistoryEntry) => b.lastVisit - a.lastVisit;

export function applyHistoryChange(list: HistoryEntry[], change: Exclude<HistoryChange, { kind: "deleted"; all: true }>): HistoryEntry[] {
  switch (change.kind) {
    case "visit": {
      if (!shownInHistory(change.url)) return list;
      const old = list.find((h) => h.url === change.url);
      if (old?.visitTimes?.includes(change.at)) return list;
      const times = [...(old?.visitTimes ?? []), change.at].sort((a, b) => a - b).slice(-MAX_VISIT_TIMES);
      const entry: HistoryEntry = {
        url: change.url,
        title: change.title || old?.title || "",
        favicon: null,
        visits: Math.max(change.visits, 1),
        lastVisit: times[times.length - 1]!,
        visitTimes: times,
      };
      const rest = list.filter((h) => h !== old);
      const at = rest.findIndex((h) => h.lastVisit <= entry.lastVisit);
      return (at < 0 ? [...rest, entry] : [...rest.slice(0, at), entry, ...rest.slice(at)]).slice(0, MAX_HISTORY);
    }
    case "modified": {
      const rows = new Map(change.rows.map((r) => [r.url, r]));
      let changed = false;
      const next = list.map((h) => {
        const row = rows.get(h.url);
        if (!row || ((row.title === h.title || !row.title) && row.visits === h.visits)) return h;
        changed = true;
        return { ...h, title: row.title || h.title, visits: row.visits };
      });
      return changed ? next : list;
    }
    case "deleted": {
      const gone = new Set(change.urls);
      const next = list.filter((h) => !gone.has(h.url));
      return next.length === list.length ? list : next;
    }
  }
}

export function createHistoryService(browser: BrowserStore) {
  const store = () => browser.getState();
  let active = true;
  let generation = 0;
  let stopListening: (() => void) | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const current = (run: number) => active && generation === run;
  const engineProfiles = (s: Pick<BrowserState, "spaces">) => [
    ...new Set(
      Object.keys(s.spaces)
        .filter((id) => !isIncognitoSpace(id))
        .map((id) => engineProfileFor(id, s.spaces)),
    ),
  ];

  const profilesUsing = (s: Pick<BrowserState, "spaces">, engine: string) =>
    Object.keys(s.spaces).filter((id) => !isIncognitoSpace(id) && engineProfileFor(id, s.spaces) === engine);

  function viewOf(engine: string): HistoryEntry[] {
    const s = store();
    for (const id of profilesUsing(s, engine)) if (s.history[id]) return s.history[id]!;
    return [];
  }

  // Sync may use a view only once history.json is in Chrome: before, its visits would read as deleted.
  let legacyMoved = false;

  /**
   * Shows `list` for the engine profile. `floor`: visits at or before it may be missing from the view (it holds
   * Chrome's newest MAX_HISTORY URLs); a read sets it, and it only rises while the view fills from events.
   */
  function setView(engine: string, list: HistoryEntry[], floor?: number) {
    if (!active) return;
    browser.setState((s) => {
      const ids = profilesUsing(s, engine);
      const was = ids.map((id) => s.historyFloor[id] ?? -Infinity).reduce((a, b) => Math.max(a, b), -Infinity);
      const full = list.length >= MAX_HISTORY ? list[list.length - 1]!.lastVisit : -Infinity;
      const next = Math.max(floor ?? was, full);
      const ready = legacyMoved;
      if (ids.every((id) => s.history[id] === list && (s.historyFloor[id] ?? -Infinity) === next && (!ready || s.historyReady[id]))) return {};
      // An absent floor means the complete history is visible. Keep the unbounded
      // value out of state so coordinator snapshots remain JSON serializable.
      const historyFloor = { ...s.historyFloor };
      for (const id of ids) {
        if (next === -Infinity) delete historyFloor[id];
        else historyFloor[id] = next;
      }
      return {
        history: { ...s.history, ...Object.fromEntries(ids.map((id) => [id, list])) },
        historyFloor,
        ...(ready ? { historyReady: { ...s.historyReady, ...Object.fromEntries(ids.map((id) => [id, true as const])) } } : {}),
      };
    });
  }

  // MARK: Loading

  type Load = { running: Promise<void>; again: boolean; queued: HistoryChange[] };
  const loads = new Map<string, Load>();
  const loaded = new Set<string>();
  // Profiles whose old file is being moved in: their views are read again once it's done, not per added visit.
  const migrating = new Set<string>();

  function load(engine: string): Promise<void> {
    if (!active) return Promise.resolve();
    const run = generation;
    const running = loads.get(engine);
    if (running) {
      running.again = true;
      return running.running;
    }
    const state: Load = { running: Promise.resolve(), again: false, queued: [] };
    loads.set(engine, state);
    state.running = (async () => {
      try {
        do {
          state.again = false;
          state.queued = [];
          await watchHistory(engine);
          if (!current(run)) return;
          const read = await queryHistory(engine, MAX_HISTORY, MAX_VISIT_TIMES);
          if (!current(run)) return;
          // Chrome had more URLs than the view reads: the older ones may be missing (shown or not).
          const floor = read.length >= MAX_HISTORY ? Math.min(...read.map((e) => e.visitTimes.at(-1) ?? 0)) : -Infinity;
          let list = read
            .filter((e) => shownInHistory(e.url))
            .map(toEntry)
            .sort(byLastVisit);
          for (const change of state.queued) if (!(change.kind === "deleted" && change.all)) list = applyHistoryChange(list, change);
          if (state.queued.some((c) => c.kind === "deleted" && c.all)) state.again = true;
          setView(engine, list, floor);
          loaded.add(engine);
        } while (current(run) && state.again);
      } catch (error) {
        console.warn(`[history] couldn't read ${engine || "the default profile"}'s history`, error);
      } finally {
        if (loads.get(engine) === state) loads.delete(engine);
      }
    })();
    return state.running;
  }

  function changed(change: HistoryChange) {
    if (!active) return;
    const engine = change.profile;
    if (migrating.has(engine)) return;
    const running = loads.get(engine);
    if (running) return void running.queued.push(change);
    if (!loaded.has(engine)) return;
    if (change.kind === "deleted" && change.all) return void load(engine);
    setView(engine, applyHistoryChange(viewOf(engine), change));
  }

  // MARK: The old file

  type LegacyFile = { history?: Record<string, HistoryEntry[]> };

  /**
   * Adds history.json's visits that Chrome doesn't have (imports, other Macs' synced history, visits it never
   * saw) to Chrome, then deletes the file once Chrome has committed. Adding again is harmless (each visit Chrome
   * has accounts for one saved visit), so a launch that stops halfway starts over. Profiles that no longer exist
   * are dropped.
   */
  async function migrateHistoryFile(now = Date.now(), { keepMs = LEGACY_HISTORY_KEPT_MS } = {}): Promise<"none" | "moved" | "kept"> {
    const run = generation;
    let file: LegacyFile | null = null;
    try {
      const json = readDocument(LEGACY_HISTORY_FILE);
      file = json ? (JSON.parse(json) as LegacyFile) : null;
    } catch (error) {
      console.warn(`[history] ${LEGACY_HISTORY_FILE} is unreadable; leaving it`, error);
      return "kept";
    }
    if (!file) return "none";
    const s = store();
    const perEngine = new Map<string, HistoryEntry[]>();
    for (const [spaceId, list] of Object.entries(file.history ?? {})) {
      if (!s.spaces[spaceId] || isIncognitoSpace(spaceId) || !Array.isArray(list)) continue;
      const engine = engineProfileFor(spaceId, s.spaces);
      // Profiles sharing data saved the same list.
      if (!perEngine.has(engine)) perEngine.set(engine, list);
    }
    for (const engine of perEngine.keys()) migrating.add(engine);
    try {
      for (const [engine, list] of perEngine) {
        const pages = list
          .filter((e) => e && typeof e.url === "string")
          .map((e) => ({
            url: e.url,
            title: e.title ?? "",
            visitTimes: (e.visitTimes?.length ? e.visitTimes : [e.lastVisit]).filter((t) => typeof t === "number" && t > now - CHROME_HISTORY_KEEPS_MS),
          }))
          .filter((p) => p.visitTimes.length);
        for (let i = 0; i < pages.length; i += HISTORY_CHUNK) {
          if (!current(run)) return "kept";
          await addHistoryVisits(engine, pages.slice(i, i + HISTORY_CHUNK), LEGACY_HISTORY_TOLERANCE_MS);
        }
      }
    } catch (error) {
      console.warn(`[history] moving ${LEGACY_HISTORY_FILE} into Chrome failed; trying again next launch`, error);
      return "kept";
    } finally {
      if (current(run)) migrating.clear();
    }
    if (!current(run)) return "kept";
    if (keepMs) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (current(run)) removeDocument(LEGACY_HISTORY_FILE);
      }, keepMs);
      timers.add(timer);
    } else removeDocument(LEGACY_HISTORY_FILE);
    return "moved";
  }

  // MARK: Start

  function startHistory() {
    if (stopListening) return stopListening;
    active = true;
    const run = generation;
    const events = onHistoryChanged((change) => {
      if (current(run)) changed(change);
    });
    const loadAll = (s: Pick<BrowserState, "spaces">) => {
      for (const engine of engineProfiles(s)) if (!loaded.has(engine) && !loads.has(engine)) void load(engine);
    };
    // With an old history.json to move in, the views are first read (and Chrome's changes watched) once it's in:
    // watching during the move sent the JS one event per moved visit (~88,000 for a long-used profile, ~200 ms of
    // the startup JS), all of them ignored, and the views are read again after it anyway.
    let moving = readDocument(LEGACY_HISTORY_FILE) !== null;
    if (!moving) loadAll(store());
    void migrateHistoryFile().then((result) => {
      if (!current(run)) return;
      legacyMoved = result !== "kept";
      if (moving) {
        moving = false;
        loadAll(store());
      } else if (result === "moved") void reloadHistory();
      else if (legacyMoved) for (const engine of loaded) setView(engine, viewOf(engine));
    });
    const stop = browser.subscribe((s, prev) => {
      if (s.spaces === prev.spaces) return;
      if (!moving) loadAll(s);
      // A profile sharing another's data shows its list at once.
      for (const id of Object.keys(s.spaces)) {
        if (prev.spaces[id] || isIncognitoSpace(id) || s.history[id]) continue;
        const list = viewOf(engineProfileFor(id, s.spaces));
        if (list.length) setView(engineProfileFor(id, s.spaces), list);
      }
    });
    stopListening = () => {
      if (!current(run)) return;
      active = false;
      generation++;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      loads.clear();
      migrating.clear();
      stopListening = undefined;
      events.remove();
      stop();
      loaded.clear();
      legacyMoved = false;
    };
    return stopListening;
  }

  /** Re-reads every profile's history from Chrome (the dev harness, tests). */
  const reloadHistory = () => Promise.all(engineProfiles(store()).map(load));

  function dispose() {
    if (stopListening) {
      stopListening();
      return;
    }
    active = false;
    generation++;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    loads.clear();
    migrating.clear();
    loaded.clear();
    legacyMoved = false;
  }

  return { start: startHistory, reload: reloadHistory, migrateFile: migrateHistoryFile, dispose };
}

const historyService = createHistoryService(useBrowser);
export const startHistory = historyService.start;
export const reloadHistory = historyService.reload;
export const migrateHistoryFile = historyService.migrateFile;
