import * as Effect from "effect/Effect";
import { useBrowser } from "../store/browserStore";
import { viewTabIds } from "../store/model";
import { runDesktop } from "../effect/runtime";
import { SOURCES } from "./sources";
import { createFolder, live, markRead, removeFolder } from "./activityStore";
import { ActivityService } from "./activityService";
import { LiveError, type LiveFolderKind, type LiveItem, type LiveSourceId } from "./types";

/** Refreshes a folder: the sources are asked, and the answers land in the store. */
export function refreshFolder(folderId: string): Promise<void> {
  return runDesktop(
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

/** Starts the live folders' refresh: the sweep, and the checks that ask for a folder the user is looking at. */
export function startLiveEngine() {
  void runDesktop(
    Effect.gen(function* () {
      const activity = yield* ActivityService;

      yield* activity.start;
    }),
  );
}
