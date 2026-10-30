import { setSidebarKeyboard } from "@bay/shell";
import { useBrowser } from "../../store/browser";
import { activeTabId } from "../../store/model";
import { dismissPeek } from "../layout/peekDismiss";
import { live, setLive, updateFolder } from "../../live/store";
import { sidebarKeyboardRows } from "./entries";
import { adjacentKeyboardRow, reconcileKeyboardRow, type SidebarKeyboardRow } from "./keyboardModel";
import { setSidebarUi, sidebarUi } from "./state";

export type { SidebarKeyboardRow } from "./keyboardModel";
export type SidebarKeyboardActions = {
  open(row: SidebarKeyboardRow): void;
  peek(row: SidebarKeyboardRow): void;
  close(row: SidebarKeyboardRow): void;
  rename(row: SidebarKeyboardRow): void;
  focusPage(): void;
};
const actions = new Map<string, SidebarKeyboardActions>();
const extensions = new Map<string, Map<string, SidebarKeyboardRow[]>>();
const previous = new Map<string, SidebarKeyboardRow[]>();
const listeners = new Map<string, () => void>();

export function registerSidebarKeyboardActions(windowId: string, value: SidebarKeyboardActions, changed: () => void) {
  actions.set(windowId, value);
  listeners.set(windowId, changed);
  return () => {
    if (actions.get(windowId) !== value) return;
    actions.delete(windowId);
    listeners.delete(windowId);
    if (!useBrowser.getState().windows[windowId]) {
      previous.delete(windowId);
      const keyboard = { ...sidebarUi().keyboard };
      delete keyboard[windowId];
      setSidebarUi({ keyboard });
      void setSidebarKeyboard(windowId, false);
    }
  };
}

/** LocalFiles can register visible rows before LiveFolders, with namespaced IDs and its own actions.
 * Register on visible-row changes, and unregister on unmount. Use SidebarKeyboardRowView for each row. */
export function registerSidebarKeyboardRows(windowId: string, spaceId: string, source: string, rows: SidebarKeyboardRow[]) {
  const key = `${windowId}|${spaceId}`;
  let sources = extensions.get(key);
  if (!sources) extensions.set(key, (sources = new Map()));
  sources.set(source, rows);
  listeners.get(windowId)?.();
  return () => {
    if (sources.get(source) !== rows) return;
    sources.delete(source);
    if (!sources.size) extensions.delete(key);
    listeners.get(windowId)?.();
  };
}

export function keyboardRows(windowId: string) {
  const s = useBrowser.getState();
  const spaceId = s.windows[windowId]?.spaceId;
  const extra = [...(extensions.get(`${windowId}|${spaceId}`)?.values() ?? [])].flat();
  return sidebarKeyboardRows(s, windowId, live(), extra);
}

export function focusedKeyboardRow(windowId: string) {
  const id = sidebarUi().keyboard[windowId]?.rowId;
  return id ? keyboardRows(windowId).find((row) => row.id === id) : undefined;
}

function focusRow(windowId: string, row?: SidebarKeyboardRow) {
  const current = sidebarUi().keyboard[windowId];
  if (current?.active && current.rowId === (row?.id ?? null)) return;
  // Hold the stable responder while React replaces, collapses or unmounts the previous row.
  void setSidebarKeyboard(windowId, true);
  setSidebarUi({ keyboard: { ...sidebarUi().keyboard, [windowId]: { rowId: row?.id ?? null, active: true } }, hover: null });
  previous.set(windowId, keyboardRows(windowId));
}

export function focusSidebar(windowId: string) {
  const s = useBrowser.getState();
  const w = s.windows[windowId];
  if (!w || w.kind === "small") return;
  // Reveal a hidden or top-layout sidebar before asking its rows for frames.
  if ((w.tabLayout ?? s.settings.tabLayout) !== "sidebar") s.toggleTabLayout(windowId);
  if (!useBrowser.getState().windows[windowId]?.sidebarOpen) useBrowser.getState().toggleSidebar(windowId);
  s.closePanel(windowId);
  const rows = keyboardRows(windowId);
  const remembered = sidebarUi().keyboard[windowId]?.rowId;
  const active = activeTabId(s, windowId);
  focusRow(
    windowId,
    rows.find((row) => row.id === remembered) ??
      rows.find((row) => (row.kind === "tab" || row.kind === "split" || row.kind === "liveItem") && row.tabIds.includes(active ?? "")) ??
      rows[0],
  );
}

export function blurSidebar(windowId: string) {
  const current = sidebarUi().keyboard[windowId];
  if (current?.active) {
    setSidebarUi({ keyboard: { ...sidebarUi().keyboard, [windowId]: { ...current, active: false } } });
    void setSidebarKeyboard(windowId, false);
  }
}

export function reconcileSidebarKeyboard(windowId: string) {
  const rows = keyboardRows(windowId);
  const current = sidebarUi().keyboard[windowId];
  if (current?.active && current.rowId) {
    const row = reconcileKeyboardRow(rows, current.rowId, previous.get(windowId) ?? []);
    if (row?.id !== current.rowId) focusRow(windowId, row);
  } else if (current?.active && rows.length) focusRow(windowId, rows[0]);
  previous.set(windowId, rows);
}

function expand(row: SidebarKeyboardRow, collapsed: boolean) {
  const s = useBrowser.getState();
  if (row.expand) row.expand(collapsed);
  else if (row.kind === "folder") s.updatePinnedFolder(row.id.slice(2), { collapsed });
  else if (row.kind === "group") s.updateGroup(row.id.slice(2), { collapsed });
  else if (row.kind === "liveFolder") updateFolder(row.folderId!, { collapsed });
  else if (row.kind === "stack") setLive((state) => ({ expandedStacks: { ...state.expandedStacks, [row.section!]: !collapsed } }));
}

export function renameKeyboardRow(windowId: string): boolean {
  if (!sidebarUi().keyboard[windowId]?.active) return false;
  const row = focusedKeyboardRow(windowId);
  if (row?.rename) row.rename();
  else if (row) actions.get(windowId)?.rename(row);
  return true;
}

export function runSidebarKey(windowId: string, key: string) {
  if (!sidebarUi().keyboard[windowId]?.active) return;
  reconcileSidebarKeyboard(windowId);
  const rows = keyboardRows(windowId);
  const row = focusedKeyboardRow(windowId);
  const effect = actions.get(windowId);
  if (key === "Escape") {
    dismissPeek(windowId);
    blurSidebar(windowId);
    effect?.focusPage();
    return;
  }
  if (key === "ArrowDown" || key === "ArrowUp") return focusRow(windowId, adjacentKeyboardRow(rows, row?.id, key === "ArrowDown" ? 1 : -1));
  if (key === "Home" || key === "End") return focusRow(windowId, key === "Home" ? rows[0] : rows.at(-1));
  if (!row) return;
  if (key === "ArrowRight") {
    if (row.collapsed) expand(row, false);
    else {
      const child = rows.find((candidate) => candidate.parentId === row.id);
      if (child) focusRow(windowId, child);
    }
  } else if (key === "ArrowLeft") {
    if (row.collapsed === false) expand(row, true);
    else if (row.parentId)
      focusRow(
        windowId,
        rows.find((candidate) => candidate.id === row.parentId),
      );
  } else if (key === "Enter") {
    if (row.collapsed !== undefined) expand(row, !row.collapsed);
    else if (row.kind === "more") setLive((s) => ({ showAll: { ...s.showAll, [`${row.folderId}:${row.section}`]: true } }));
    else (row.open ?? (() => effect?.open(row)))();
  } else if (key === "Space") (row.peek ?? (() => effect?.peek(row)))();
  else if (key === "Backspace") (row.close ?? (() => effect?.close(row)))();
}
