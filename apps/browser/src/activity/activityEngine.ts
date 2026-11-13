import * as Effect from "effect/Effect";
import { hasServiceClient, requestService, sendService } from "../runtime/serviceClient";
import { useBrowser, type BrowserStore } from "../store/browserStore";
import { viewTabIds } from "../store/model";
import { runForStore } from "../effect/runtime";
import { startStoreService } from "../effect/storeService";
import { SOURCES } from "./sources";
import { bindLiveStoreBrowser, createFolder, live, markRead, removeFolder } from "./activityStore";
import { ActivityService } from "./activityService";
import { LiveError, type LiveFolderKind, type LiveItem, type LiveSourceId } from "./types";

/**
 * The store the live engine works on.
 *
 * The coordinator owns the store, so the engine works on the authority it was given rather than on the app's
 * imported one. The unbind gives the previous owner back.
 */
let owner: BrowserStore = useBrowser;

// The store's live refresh, so one store that starts it twice gets one sweep and one stop.
const engines = new WeakMap<BrowserStore, () => void>();

export function bindLiveBrowser(browser: BrowserStore): () => void {
  const previous = owner;
  owner = browser;
  const release = bindLiveStoreBrowser(browser);

  return () => {
    release();

    if (owner === browser) owner = previous;
  };
}

/** Refreshes a folder: the sources are asked, and the answers land in the store. */
export function refreshFolder(folderId: string, browser: BrowserStore = owner): Promise<void> {
  if (hasServiceClient()) return requestService("liveRefresh", [folderId]);

  return runForStore(
    browser,
    Effect.gen(function* () {
      const activity = yield* ActivityService;

      yield* activity.refresh(folderId);
    }),
  );
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

export function newLiveFolder(windowId: string, kind: LiveFolderKind, browser: BrowserStore = owner): string | null | Promise<string | null> {
  if (hasServiceClient()) return requestService("liveCreate", [windowId, kind]);
  const w = browser.getState().windows[windowId];

  if (!w || w.incognito) return null;
  const s = live();

  const sources: LiveSourceId[] =
    kind === "pullRequests"
      ? (["github", "bitbucket"] as const).filter((id) => s.accounts[id])
      : (["notion", "confluence", "gdrive"] as const).filter((id) => s.accounts[id]);

  const id = createFolder(w.spaceId, kind, sources.length ? sources : undefined);
  void refreshFolder(id, browser);

  return id;
}

export function openLiveItem(
  windowId: string,
  folderId: string,
  item: LiveItem,
  options: { background?: boolean } = {},
  browser: BrowserStore = owner,
): string | Promise<string> {
  if (hasServiceClient()) return requestService("liveOpen", [windowId, folderId, item.id, !!options.background]);
  const s = browser.getState();
  markRead(folderId, [item.id]);
  const existing = viewTabIds(s, windowId).find((id) => s.tabs[id]?.liveItem?.itemId === item.id && s.tabs[id]?.liveItem?.folderId === folderId);

  if (existing) {
    if (!options.background) s.activate(existing);

    return existing;
  }

  const id = s.newTab(windowId, { url: item.url, background: options.background });
  browser.getState().updateTab(id, { liveItem: { folderId, itemId: item.id } });

  return id;
}

export function deleteLiveFolder(folderId: string, browser: BrowserStore = owner) {
  if (sendService("liveRemove", [folderId])) return;
  const s = browser.getState();

  const tabs = Object.values(s.tabs)
    .filter((t) => t.liveItem?.folderId === folderId)
    .map((t) => t.id);

  if (tabs.length) s.closeTabs(tabs);
  removeFolder(folderId);
}

// MARK: Background refresh

/**
 * Starts the live folders' refresh: the sweep, and the checks that ask for a folder the user is looking at.
 *
 * The work is the activity service's (activityService.ts). This gives the store that owns it an idempotent stop,
 * so a coordinator that goes does not leave its sweep behind.
 */
export function startLiveEngine(browser: BrowserStore = owner): () => void {
  const existing = engines.get(browser);

  if (existing) return existing;

  const forget = () => {
    if (engines.get(browser) === once) engines.delete(browser);
  };

  const stop = startStoreService(
    browser,
    "The live folders could not be watched",
    Effect.gen(function* () {
      const activity = yield* ActivityService;

      yield* activity.start;
    }),
    Effect.gen(function* () {
      const activity = yield* ActivityService;

      yield* activity.stop;
    }),
    forget,
  );

  const once = () => {
    forget();
    stop();
  };

  engines.set(browser, once);

  return once;
}
