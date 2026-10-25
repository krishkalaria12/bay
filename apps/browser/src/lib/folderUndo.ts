import { setSidebarMoveUndo } from "@bay/shell";
import { useBrowser } from "../store/browser";

/** The drag or menu is finished; the sidebar can now own Undo. */
export function armSidebarMoveUndo(windowId: string) {
  const s = useBrowser.getState();
  if (!s.windows[windowId] || !s.sidebarUndo[windowId]?.length) return;
  void setSidebarMoveUndo(windowId, true, true);
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
