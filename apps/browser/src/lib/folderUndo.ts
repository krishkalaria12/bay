import { setSidebarMoveUndo } from "@bay/shell";
import { reportBrowserCommand } from "../runtime/commands";
import { useBrowserRead as useBrowser } from "../store/read";
import { browserRead } from "../store/read";

/** Call after a successful sidebar move, once the drag/menu has finished. */
export function armSidebarMoveUndo(windowId: string) {
  const s = browserRead.getState();
  if (!s.windows[windowId] || !s.folderMoveUndo.length) return;
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
    for (const id of s.windowOrder) void setSidebarMoveUndo(id, !!s.folderMoveUndo.length);
  };
  sync();
  return useBrowser.subscribe((s, prev) => {
    if (s.folderMoveUndo !== prev.folderMoveUndo) sync();
  });
}
