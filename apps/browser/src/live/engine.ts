import { onWindowEvent } from "@bay/shell";
import { useBrowser, type BrowserStore } from "../store/browser";
import { activeTabId, pinnedPage, viewTabIds } from "../store/model";
import { SOURCES } from "./sources";
import { applyFetch, createFolder, finishCompleting, live, markRead, removeFolder, setStatus, useLive } from "./store";
import { LiveError, type CompletionState, type LiveFolderKind, type LiveItem, type LiveSourceId, type PullRequestSection } from "./types";
import { COMPLETION_MS, REFRESH_INTERVAL_MS, STALE_ON_FOCUS_MS } from "./constants";

type RefreshScope = { active: boolean; timers: Set<ReturnType<typeof setTimeout>> };
const inflight = new Map<string, { promise: Promise<void>; scope?: RefreshScope }>();
let engine: { scope: RefreshScope; stop: () => void } | undefined;

function later(scope: RefreshScope | undefined, callback: () => void, delay: number) {
  const timer = setTimeout(() => {
    scope?.timers.delete(timer);
    if (!scope || scope.active) callback();
  }, delay);
  scope?.timers.add(timer);
}
const fetchedSources = new Map<string, Set<LiveSourceId>>();

const SECTION_ORDER: Record<PullRequestSection, number> = { authored: 0, review: 1, team: 2 };

function order(items: LiveItem[]): LiveItem[] {
  return [...items].sort((a, b) => (SECTION_ORDER[a.section ?? "authored"] ?? 0) - (SECTION_ORDER[b.section ?? "authored"] ?? 0) || b.updatedAt - a.updatedAt);
}

export function refreshFolder(folderId: string): Promise<void> {
  const running = inflight.get(folderId);
  if (running) return running.promise;
  const scope = engine?.scope;
  const task = {
    scope,
    promise: run(folderId, scope).finally(() => {
      if (inflight.get(folderId) === task) inflight.delete(folderId);
    }),
  };
  inflight.set(folderId, task);
  return task.promise;
}

async function run(folderId: string, scope?: RefreshScope) {
  const active = () => (!scope || scope.active) && !!live().folders[folderId];
  const folder = live().folders[folderId];
  if (!folder) return;
  const before = live();
  setStatus(folderId, { state: before.status[folderId]?.lastFetch ? "updating" : "initializing" });
  const prev = before.items[folderId] ?? [];
  const animating = new Set(before.completing[folderId] ?? []);
  const results = await Promise.allSettled(folder.sources.map((id) => SOURCES[id].fetch(folder)));

  const next: LiveItem[] = [];
  const failed: { source: LiveSourceId; error: unknown }[] = [];
  results.forEach((r, i) => {
    const source = folder.sources[i]!;
    if (r.status === "fulfilled") next.push(...r.value);
    else {
      failed.push({ source, error: r.reason });
      next.push(...prev.filter((it) => it.source === source && !animating.has(it.id)));
    }
  });
  if (!active()) return;

  const ids = new Set(next.map((it) => it.id));
  const missing = prev.filter((it) => !ids.has(it.id) && !animating.has(it.id) && !failed.some((f) => f.source === it.source));
  const gone: Record<string, CompletionState> = {};
  for (const source of new Set(missing.map((it) => it.source))) {
    const resolve = SOURCES[source].resolveGone;
    if (!resolve) continue;
    Object.assign(gone, await resolve(missing.filter((it) => it.source === source)).catch(() => ({})));
    if (!active()) return;
  }

  const firstFailure = failed[0];
  if (firstFailure && failed.length === folder.sources.length && !prev.length && !before.status[folderId]?.lastFetch) {
    setStatus(folderId, { state: "error", error: describe(firstFailure.source, firstFailure.error) });
    return;
  }
  const lastSources = fetchedSources.get(folderId);
  const quiet = new Set(lastSources ? next.filter((it) => !lastSources.has(it.source)).map((it) => it.id) : []);
  fetchedSources.set(folderId, new Set(folder.sources.filter((id) => !failed.some((f) => f.source === id))));
  applyFetch(folderId, order(next), gone, Date.now(), quiet);
  if (firstFailure) setStatus(folderId, { state: "error", error: describe(firstFailure.source, firstFailure.error) });
  const leaving = Object.keys(gone);
  if (leaving.length)
    later(
      scope,
      () => {
        if (live().folders[folderId]) finishCompleting(folderId, leaving);
      },
      COMPLETION_MS,
    );
}

function describe(source: LiveSourceId, error: unknown) {
  if (error instanceof LiveError) return { kind: error.kind, message: error.message, source };
  return { kind: "other" as const, message: String((error as Error)?.message ?? error), source };
}

export function statusText(folderId: string, now = Date.now()): string {
  const st = live().status[folderId];
  if (!st || st.state === "initializing") return "Loading…";
  if (st.state === "updating") return "Updating…";
  if (st.error) return errorText(st.error.kind, st.error.source);
  if (!st.lastFetch) return "Not updated yet";
  const min = Math.floor((now - st.lastFetch) / 60_000);
  return min < 1 ? "Updated just now" : min < 60 ? `Updated ${min} min ago` : `Updated ${Math.floor(min / 60)} hr ago`;
}

export function errorText(kind: LiveError["kind"], source: LiveSourceId): string {
  const name = SOURCES[source].name;
  switch (kind) {
    case "notConfigured":
      return `Connect ${name} in Settings`;
    case "signedOut":
      return `Sign back in to ${name}`;
    case "sso":
      return `${name} needs Single Sign-On for this organization`;
    case "rateLimited":
      return `${name} rate limit exceeded. Try again in a few minutes.`;
    case "network":
      return `Couldn't connect to ${name}`;
    default:
      return `We're having trouble connecting to ${name}`;
  }
}

// MARK: Folder actions

export function newLiveFolder(windowId: string, kind: LiveFolderKind): string | null {
  const w = useBrowser.getState().windows[windowId];
  if (!w || w.incognito) return null;
  const s = live();
  const sources: LiveSourceId[] =
    kind === "pullRequests"
      ? (["github", "bitbucket"] as const).filter((id) => s.accounts[id])
      : (["notion", "confluence", "gdrive"] as const).filter((id) => s.accounts[id]);
  const id = createFolder(w.spaceId, kind, sources.length ? sources : undefined);
  void refreshFolder(id);
  return id;
}

export function openLiveItem(windowId: string, folderId: string, item: LiveItem, options: { background?: boolean } = {}) {
  const s = useBrowser.getState();
  markRead(folderId, [item.id]);
  const existing = viewTabIds(s, windowId).find((id) => s.tabs[id]?.liveItem?.itemId === item.id && s.tabs[id]?.liveItem?.folderId === folderId);
  if (existing) {
    if (!options.background) s.activate(existing);
    return existing;
  }
  const id = s.newTab(windowId, { url: item.url, background: options.background });
  useBrowser.getState().updateTab(id, { liveItem: { folderId, itemId: item.id } });
  return id;
}

export function deleteLiveFolder(folderId: string) {
  const s = useBrowser.getState();
  const tabs = Object.values(s.tabs)
    .filter((t) => t.liveItem?.folderId === folderId)
    .map((t) => t.id);
  if (tabs.length) s.closeTabs(tabs);
  removeFolder(folderId);
}

// MARK: Background refresh

export function startLiveEngine(browser: BrowserStore = useBrowser): () => void {
  if (engine) return engine.stop;
  const scope: RefreshScope = { active: true, timers: new Set() };
  const disposers: (() => void)[] = [];
  const lastNudge = new Map<string, number>();
  const stop = () => {
    if (!scope.active) return;
    scope.active = false;
    scope.timers.forEach(clearTimeout);
    scope.timers.clear();
    for (const [id, task] of inflight) if (task.scope === scope) inflight.delete(id);
    if (engine?.scope === scope) engine = undefined;
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (error) {
        console.warn("Couldn't stop live folder watcher", error);
      }
    }
  };
  engine = { scope, stop };

  try {
    // A stopped service cancels completion timers; resume those animations here.
    for (const [folderId, ids] of Object.entries(live().completing)) {
      if (ids.length)
        later(
          scope,
          () => {
            if (live().folders[folderId]) finishCompleting(folderId, ids);
          },
          COMPLETION_MS,
        );
    }

    const orphans = () => {
      const s = browser.getState();
      const folders = live().folders;
      for (const t of Object.values(s.tabs)) if (t.liveItem && !folders[t.liveItem.folderId]) s.updateTab(t.id, { liveItem: undefined });
    };
    orphans();
    disposers.push(
      useLive.subscribe((s, prev) => {
        if (s.folders !== prev.folders) orphans();
      }),
    );

    disposers.push(
      browser.subscribe((s, prev) => {
        if (s.spaces === prev.spaces) return;
        for (const f of Object.values(live().folders)) if (!s.spaces[f.spaceId]) removeFolder(f.id);
      }),
    );

    const due = (id: string, maxAge: number) => {
      const f = live().folders[id];
      const st = live().status[id];
      return !!f && (!st?.lastFetch || Date.now() - st.lastFetch >= maxAge);
    };
    later(scope, () => live().folderOrder.forEach((id) => void refreshFolder(id)), 2500);
    const interval = setInterval(() => {
      for (const id of live().folderOrder) if (due(id, REFRESH_INTERVAL_MS[live().folders[id]!.kind])) void refreshFolder(id);
    }, 30_000);
    disposers.push(() => clearInterval(interval));
    const focus = onWindowEvent((e) => {
      if (scope.active && e.type === "focus") for (const id of live().folderOrder) if (due(id, STALE_ON_FOCUS_MS)) void refreshFolder(id);
    });
    disposers.push(() => focus.remove());

    disposers.push(
      browser.subscribe((s, prev) => {
        if (s.tabs === prev.tabs) return;
        for (const id in s.tabs) {
          const t = s.tabs[id]!;
          // Pinned (a tile or a row), it leaves its live folder.
          if (t.liveItem && pinnedPage(t) && !(prev.tabs[id] && pinnedPage(prev.tabs[id]!))) browser.getState().updateTab(id, { liveItem: undefined });
        }
      }),
    );

    disposers.push(
      browser.subscribe((s, prev) => {
        if (s.windows === prev.windows) return;
        for (const windowId of s.windowOrder) {
          const before = activeTabId(prev, windowId);
          if (!before || before === activeTabId(s, windowId)) continue;
          const folderId = s.tabs[before]?.liveItem?.folderId;
          if (!folderId || Date.now() - (lastNudge.get(folderId) ?? 0) < 20_000) continue;
          lastNudge.set(folderId, Date.now());
          later(scope, () => void refreshFolder(folderId), 3000);
        }
      }),
    );
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}
