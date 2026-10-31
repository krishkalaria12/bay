import { setSidebarMoveUndo } from "@bay/shell";
import { reportBrowserCommand } from "../runtime/commands";
import { useBrowserRead as useBrowser } from "../store/read";
import { browserRead } from "../store/read";

/** The drag or menu is finished; the sidebar can now own Undo. */
export function armSidebarMoveUndo(windowId: string) {
  const s = browserRead.getState();
  if (!s.windows[windowId] || !s.sidebarUndo[windowId]?.length) return;
  void setSidebarMoveUndo(windowId, true, true);
}

// The undo stack is capped, so a recorded move shows as a new last entry rather than a longer stack.
const lastFolderMove = () => JSON.stringify(browserRead.getState().folderMoveUndo.at(-1) ?? null);

/** Arms Undo once `move` is acknowledged, if it recorded a folder move. Dispatch it inside `move`. */
export function withFolderMoveUndo(windowId: string, move: () => Promise<unknown>) {
  const before = lastFolderMove();
  reportBrowserCommand(
    move().then(() => {
      if (lastFolderMove() !== before) armSidebarMoveUndo(windowId);
    }),
  );
}

export function startSidebarMoveUndoSync() {
  const sync = () => {
    const s = useBrowser.getState();
    for (const id of s.windowOrder) void setSidebarMoveUndo(id, !!s.sidebarUndo[id]?.length);
  };
  sync();
  return useBrowser.subscribe((s, prev) => {
    if (s.sidebarUndo === prev.sidebarUndo && s.windows === prev.windows) return;
    sync();
    // Only user transactions add an entry. Background page reports never claim keyboard focus.
    for (const id of s.windowOrder) {
      const latest = s.sidebarUndo[id]?.at(-1);
      if (latest && !prev.sidebarUndo[id]?.includes(latest)) armSidebarMoveUndo(id);
    }
  });
}
