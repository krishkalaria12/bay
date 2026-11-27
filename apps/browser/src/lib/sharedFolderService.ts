import { platformOS } from "@bay/platform";
import {
  forgetSharedFolder,
  onSharedFolderChange,
  pickSharedFolder,
  readDocument,
  readSharedFolder,
  removeSharedLink,
  revealSharedFolder,
  shareSharedFolder,
  watchSharedFolder,
  writeDocument,
  writeSharedLink,
} from "@bay/desktop";
import * as v from "valibot";
import { create } from "zustand";
import { requestService, hasServiceClient } from "../runtime/serviceClient";
import type { BrowserStore } from "../store/browserStore";
import { withoutSidebarUndo } from "../store/sidebarUndo";
import { switchedOff, useKillSwitches } from "./killSwitches";
import { linkText, parseLink, planChanges, planSync, type DirectoryLink, type FolderTab, type Known, type LinkFormat } from "./sharedFolders";

// Folders that stay shared (G11; the format and the sync plan are lib/sharedFolders.ts). The coordinator keeps each
// pinned folder's directory and what both held after the last sync (shared-folders.json, this computer's own: it
// never syncs to other devices), watches the directory, and syncs a folder when its directory or its tabs change.
// Windows ask through the service commands (sharedFolderBind, sharedFolderUnbind, sharedFolderSync).

const DOC = "shared-folders.json";
const SETTLE_MS = 800;

/** What a window shows of a shared folder. */
export type SharedFolderStatus = { path: string; name: string; status: "synced" | "syncing" | "paused" | "missing" | "inaccessible"; syncedAt: number | null };

export const useSharedFolders = create<{ folders: Readonly<Record<string, SharedFolderStatus>> }>(() => ({ folders: {} }));

export const FORMAT: LinkFormat = platformOS === "macos" ? "webloc" : platformOS === "windows" ? "url" : "desktop";

const LinkSchema = v.object({ url: v.string(), title: v.string() });

const BindingSchema = v.object({
  path: v.pipe(v.string(), v.nonEmpty()),
  name: v.string(),
  known: v.record(v.string(), v.object({ ...LinkSchema.entries, tabId: v.string() })),
});

type Binding = v.InferOutput<typeof BindingSchema>;

const BindingsSchema = v.object({ folders: v.record(v.string(), BindingSchema) });

let bindings: Map<string, Binding> = new Map();

function load(): Map<string, Binding> {
  try {
    const parsed = v.safeParse(BindingsSchema, JSON.parse(readDocument(DOC) ?? "null"));

    return new Map(parsed.success ? Object.entries(parsed.output.folders) : []);
  } catch {
    return new Map();
  }
}

function save() {
  try {
    writeDocument(DOC, JSON.stringify({ folders: Object.fromEntries(bindings) }));
  } catch {}
}

function setStatus(folderId: string, patch: Partial<SharedFolderStatus> | null) {
  const folders = { ...useSharedFolders.getState().folders };
  const binding = bindings.get(folderId);

  if (!patch || !binding) delete folders[folderId];
  else folders[folderId] = { path: binding.path, name: binding.name, status: "syncing", syncedAt: null, ...folders[folderId], ...patch };

  useSharedFolders.setState({ folders });
}

/** A folder's own pinned rows, as links: the page it's pinned at, and its name. */
function folderTabs(store: BrowserStore, folderId: string): FolderTab[] {
  return Object.values(store.getState().tabs).flatMap((t) =>
    t.folderId === folderId && t.pinnedRow ? [{ id: t.id, url: t.pinnedUrl ?? t.url, title: t.customTitle || t.title || t.pinnedUrl || t.url }] : [],
  );
}

const running = new Map<string, Promise<void>>();
const again = new Set<string>();

/** Syncs one folder now; a sync asked for while one runs runs once more after it. */
export function syncFolder(store: BrowserStore, folderId: string): Promise<void> {
  const current = running.get(folderId);

  if (current) {
    again.add(folderId);

    return current;
  }

  const run = syncOnce(store, folderId).finally(() => {
    running.delete(folderId);

    if (again.delete(folderId)) void syncFolder(store, folderId);
  });

  running.set(folderId, run);

  return run;
}

async function syncOnce(store: BrowserStore, folderId: string) {
  const binding = bindings.get(folderId);

  if (!binding) return;

  if (!store.getState().pinnedFolders[folderId]) return unbind(folderId, false);

  // Bay turned shared folders off for this release (lib/killSwitches.ts): nothing is read or written until it's lifted.
  if (switchedOff("sharedFolders")) return setStatus(folderId, { status: "paused" });
  setStatus(folderId, { status: "syncing" });
  const read = await readSharedFolder(binding.path);

  if (read.status !== "available") return setStatus(folderId, { status: read.status });

  const files: DirectoryLink[] = read.entries.flatMap((entry) => {
    const link = parseLink(entry.name, entry.text);

    return link ? [{ name: entry.name, ...link }] : [];
  });

  const plan = planSync(binding.known, files, folderTabs(store, folderId), FORMAT);

  if (planChanges(plan)) {
    for (const file of plan.writeFiles) await writeSharedLink(binding.path, file.name, linkText(file, FORMAT));

    for (const name of plan.removeFiles) await removeSharedLink(binding.path, name);

    const added = withoutSidebarUndo(() =>
      store.getState().applySharedLinks(folderId, { add: plan.addTabs, remove: plan.removeTabs, update: plan.updateTabs }),
    );

    const known: Known = { ...plan.known };

    plan.addTabs.forEach((file, i) => {
      if (added[i]) known[file.name] = { url: file.url, title: file.title, tabId: added[i] };
    });
    bindings.set(folderId, { ...binding, known });
    save();
  }

  setStatus(folderId, { status: "synced", syncedAt: Date.now() });
}

function bind(store: BrowserStore, folderId: string, path: string, name: string) {
  bindings.set(folderId, { path, name, known: {} });
  save();
  setStatus(folderId, { status: "syncing" });
  void watchSharedFolder(path, true);

  return syncFolder(store, folderId);
}

async function unbind(folderId: string, forget = true) {
  const binding = bindings.get(folderId);

  if (!binding) return;
  bindings.delete(folderId);
  save();
  setStatus(folderId, null);

  // The directory may hold other folders' links too: its grant goes with the last of them.
  if (![...bindings.values()].some((b) => b.path === binding.path)) {
    await watchSharedFolder(binding.path, false);

    if (forget) await forgetSharedFolder(binding.path);
  }
}

/** A folder's tabs as one string, to tell when they changed. */
const signature = (tabs: FolderTab[]) =>
  tabs
    .map((t) => `${t.id}\u0000${t.url}\u0000${t.title}`)
    .sort()
    .join("\u0001");

let owner: BrowserStore | null = null;

/** Keeps the bound folders in step for the coordinator's life. */
export function startSharedFolders(store: BrowserStore): () => void {
  owner = store;
  bindings = load();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const soon = (folderId: string) => {
    clearTimeout(timers.get(folderId));
    timers.set(
      folderId,
      setTimeout(() => void syncFolder(store, folderId), SETTLE_MS),
    );
  };

  const seen = new Map<string, string>();

  for (const [folderId, binding] of bindings) {
    void watchSharedFolder(binding.path, true);
    seen.set(folderId, signature(folderTabs(store, folderId)));
    setStatus(folderId, { status: "syncing" });
    void syncFolder(store, folderId);
  }

  // A kill switch lifted: every folder syncs again.
  const switches = useKillSwitches.subscribe((k, prev) => {
    if (k.active !== prev.active) for (const folderId of bindings.keys()) soon(folderId);
  });

  const changes = onSharedFolderChange(({ path }) => {
    for (const [folderId, binding] of bindings) if (binding.path === path) soon(folderId);
  });

  const unwatch = store.subscribe((s, prev) => {
    if (s.tabs === prev.tabs && s.pinnedFolders === prev.pinnedFolders) return;

    for (const folderId of bindings.keys()) {
      if (!s.pinnedFolders[folderId]) {
        void unbind(folderId, false);
        continue;
      }

      const now = signature(folderTabs(store, folderId));

      if (seen.get(folderId) === now) continue;
      seen.set(folderId, now);
      soon(folderId);
    }
  });

  return () => {
    owner = null;
    switches();
    changes.remove();
    unwatch();

    for (const timer of timers.values()) clearTimeout(timer);

    for (const binding of bindings.values()) void watchSharedFolder(binding.path, false);
  };
}

// MARK: Actions, from any window

const coordinator = () => {
  if (!owner) throw new Error("Shared folders aren't running");

  return owner;
};

export const bindSharedFolder = (folderId: string, path: string, name: string) => bind(coordinator(), folderId, path, name);

export const unbindSharedFolder = (folderId: string) => unbind(folderId);

export const syncSharedFolder = (folderId: string) => syncFolder(coordinator(), folderId);

/** Keep in a Shared Folder…: the person picks the directory, and the folder's links go there and stay in step. */
export async function keepInSharedFolder(folderId: string): Promise<boolean> {
  const picked = await pickSharedFolder();

  if (!picked) return false;

  if (hasServiceClient()) await requestService<null>("sharedFolderBind", [folderId, picked.path, picked.name]);
  else await bindSharedFolder(folderId, picked.path, picked.name);

  return true;
}

export async function stopSharingFolder(folderId: string): Promise<void> {
  if (hasServiceClient()) await requestService<null>("sharedFolderUnbind", [folderId]);
  else await unbindSharedFolder(folderId);
}

export async function syncSharedFolderNow(folderId: string): Promise<void> {
  if (hasServiceClient()) await requestService<null>("sharedFolderSync", [folderId]);
  else await syncSharedFolder(folderId);
}

export const showSharedFolder = (folderId: string) => {
  const status = useSharedFolders.getState().folders[folderId];

  return status ? revealSharedFolder(status.path) : Promise.resolve(false);
};

export const inviteToSharedFolder = (folderId: string) => {
  const status = useSharedFolders.getState().folders[folderId];

  return status ? shareSharedFolder(status.path) : Promise.resolve(false);
};
