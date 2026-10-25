import { localFiles, type LocalFileAccess } from "@bay/shell";
import { useBrowser } from "../store/browser";
import { activeTabId } from "../store/model";

/** Resolves native access before opening anything. Synced paths alone never authorize a file. */
export async function openLocalFile(windowId: string, pinId: string, relativePath = ""): Promise<LocalFileAccess> {
  const s = useBrowser.getState();
  const pin = s.localFiles[pinId];
  const w = s.windows[windowId];
  if (!pin || !w || w.incognito || !s.spaces[pin.spaceId]) return { status: "inaccessible" };
  const access = await localFiles.open(pin.path, relativePath);
  const next = useBrowser.getState();
  if (access.status !== "available" || !access.browserReadable || !access.url?.startsWith("file://")) return access;
  // A tab must not appear after its pin or window was removed while native resolution was pending.
  if (next.localFiles[pinId]?.path !== pin.path || !next.windows[windowId] || !next.spaces[pin.spaceId]) return { status: "inaccessible" };
  const existing = Object.values(next.tabs).find((tab) => tab.spaceId === pin.spaceId && tab.url === access.url && !tab.peekOf);
  if (existing) next.activate(existing.id, windowId);
  else next.newTab(windowId, { url: access.url, spaceId: pin.spaceId, snapshot: { title: relativePath ? (access.name ?? pin.name) : pin.name } });
  return access;
}

export async function reconnectLocalFile(pinId: string): Promise<boolean> {
  const pin = useBrowser.getState().localFiles[pinId];
  if (!pin) return false;
  // Native saves an alias under the original synced path. Reconnection is local to this Mac.
  return !!(await localFiles.reconnect(pin.path, pin.kind));
}

/** Space peeks browser-readable files; other formats keep their native app's preview/open behavior. */
export async function peekLocalFile(windowId: string, pinId: string, relativePath = ""): Promise<LocalFileAccess> {
  const pin = useBrowser.getState().localFiles[pinId];
  if (!pin) return { status: "inaccessible" };
  const access = await localFiles.inspect(pin.path, relativePath);
  const s = useBrowser.getState();
  if (s.localFiles[pinId]?.path !== pin.path || !s.windows[windowId] || s.windows[windowId]!.incognito) return { status: "inaccessible" };
  if (access.status !== "available") return access;
  const from = activeTabId(s, windowId);
  if (from && access.browserReadable && access.url?.startsWith("file://")) {
    // Shared-space tabs can still be hosted by another window. The peek belongs to this window's page.
    if (s.tabs[from]?.windowId !== windowId) s.activate(from, windowId);
    useBrowser.getState().openPeek(from, access.url);
  } else return openLocalFile(windowId, pinId, relativePath);
  return access;
}

/** Descendant rows close their opened page. They never delete or move a filesystem entry. */
export async function closeLocalFileTab(windowId: string, pinId: string, relativePath: string): Promise<void> {
  const pin = useBrowser.getState().localFiles[pinId];
  if (!pin) return;
  const access = await localFiles.inspect(pin.path, relativePath);
  const s = useBrowser.getState();
  if (s.localFiles[pinId]?.path !== pin.path || !s.windows[windowId] || !access.url) return;
  for (const tab of Object.values(s.tabs)) if (tab.spaceId === pin.spaceId && tab.url === access.url) s.closeTab(tab.id);
}

export function localFileStatusText(access: LocalFileAccess | null): string {
  if (!access) return "Checking access…";
  return access.status === "missing" ? "Missing on this Mac" : access.status === "inaccessible" ? "Access required on this Mac" : "";
}
