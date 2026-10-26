import type { LiveItem } from "../../live/types";

/** Stable, namespaced row identity; never the tab selection. Extension rows use their own prefix. */
export type SidebarKeyboardRow = {
  id: string;
  kind: "tab" | "folder" | "group" | "split" | "liveFolder" | "liveItem" | "stack" | "more" | "local";
  parentId?: string;
  tabIds: string[];
  collapsed?: boolean;
  folderId?: string;
  item?: LiveItem;
  section?: string;
  open?(): void;
  peek?(): void;
  close?(): void;
  rename?(): void;
  expand?(collapsed: boolean): void;
};

export function adjacentKeyboardRow(rows: SidebarKeyboardRow[], id: string | undefined, delta: number) {
  const at = rows.findIndex((row) => row.id === id);
  return rows[Math.max(0, Math.min(rows.length - 1, at < 0 ? (delta < 0 ? rows.length - 1 : 0) : at + delta))];
}

/** After deletion/collapse, prefer the surviving parent, then the row that took its position. */
export function reconcileKeyboardRow(rows: SidebarKeyboardRow[], id: string, previous: SidebarKeyboardRow[]) {
  const current = rows.find((row) => row.id === id);
  if (current) return current;
  let old = previous.find((row) => row.id === id);
  const visited = new Set<string>();
  while (old?.parentId && !visited.has(old.parentId)) {
    visited.add(old.parentId);
    const parent = rows.find((row) => row.id === old!.parentId);
    if (parent) return parent;
    old = previous.find((row) => row.id === old!.parentId);
  }
  return rows[
    Math.max(
      0,
      Math.min(
        rows.length - 1,
        previous.findIndex((row) => row.id === id),
      ),
    )
  ];
}
