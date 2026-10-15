import { setSidebarMoveUndo } from "@bay/shell";
import { useBrowser } from "../store/browser";

/** Call after a successful sidebar move, once the drag/menu has finished. */
export function armSidebarMoveUndo(windowId: string) {
  const s = useBrowser.getState();
  if (!s.windows[windowId] || !s.folderMoveUndo.length) return;
  void setSidebarMoveUndo(windowId, true, true);
}

export function startSidebarMoveUndoSync() {
  const sync = () => {
    const s = useBrowser.getState();
    for (const id of s.windowOrder) void setSidebarMoveUndo(id, !!s.folderMoveUndo.length);
  };
  sync();
  return useBrowser.subscribe((s, prev) => {
    if (s.folderMoveUndo !== prev.folderMoveUndo) sync();
  });
}
