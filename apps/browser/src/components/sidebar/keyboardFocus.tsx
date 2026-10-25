import { focusSidebarRow, prompt } from "@bay/shell";
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { findNodeHandle, StyleSheet, View, type ScrollView, type ViewProps } from "react-native";
import { closeTab } from "../../lib/actions";
import { useTheme } from "../../lib/theme";
import { webviews } from "../../lib/webviews";
import { openLiveItem } from "../../live/engine";
import { live, updateFolder, useLive } from "../../live/store";
import { useShallow } from "zustand/react/shallow";
import { sidebarKeyboardRows } from "./entries";
import { useBrowser } from "../../store/browser";
import { activeTabId } from "../../store/model";
import { usePageSpaceId, useWindowId } from "../../store/hooks";
import { clickTab, startRename } from "./actions";
import { dismissHover } from "./hover";
import { blurSidebar, focusSidebar, reconcileSidebarKeyboard, registerSidebarKeyboardActions, type SidebarKeyboardRow } from "./keyboard";
import { measureRow, registerRow, setSidebarUi, useSidebarUi } from "./state";

const VisibleRows = createContext<Set<string> | null>(null);

export function SidebarKeyboardScope({ children }: { children: ReactNode }) {
  const windowId = useWindowId();
  const liveState = useLive();
  const ids = useBrowser(useShallow((s) => sidebarKeyboardRows(s, windowId, liveState).map((row) => row.id)));
  const visible = useMemo(() => new Set(ids), [ids]);
  return <VisibleRows.Provider value={visible}>{children}</VisibleRows.Provider>;
}

const revealers = new Map<string, (view: View) => void>();

/** A row's visual ring and VoiceOver target are independent of active-tab and multi-selection styling. */
export function SidebarKeyboardRowView({ rowId, legacyId, label, children, ...props }: ViewProps & { rowId: string; legacyId?: string; label?: string }) {
  const windowId = useWindowId();
  const spaceId = usePageSpaceId();
  const visibleRows = useContext(VisibleRows);
  const current = useBrowser((s) => s.windows[windowId]?.spaceId === spaceId);
  const extension = !/^(t:|s:|g:|f:|livefolder\||live\||stack\||more\|)/.test(rowId);
  const folded = useBrowser((s) => !!s.spaces[spaceId]?.folded);
  const visible = current && (extension ? !folded : !visibleRows || visibleRows.has(rowId));
  const renameId = useSidebarUi((s) => (s.renaming?.windowId === windowId ? s.renaming.id : null));
  const renaming = useBrowser(
    (s) => !!renameId && (renameId === legacyId || (rowId.startsWith("s:") && !!s.splits[rowId.slice(2)]?.tabIds.includes(renameId))),
  );
  const focused = useSidebarUi((s) => current && !!s.keyboard[windowId]?.active && s.keyboard[windowId]?.rowId === rowId);
  const theme = useTheme();
  const ref = useRef<View>(null);
  // Collapse animations and newly mounted rows settle after focus changes. Cancel old work on rapid arrow presses.
  useEffect(() => {
    if (!focused || renaming || !visible) return;
    const timers = [0, 80, 220].map((ms) =>
      setTimeout(() => {
        if (!ref.current) return;
        revealers.get(windowId)?.(ref.current);
        if (ms === 220) {
          const tag = findNodeHandle(ref.current);
          if (tag) void focusSidebarRow(windowId, tag);
        }
      }, ms),
    );
    return () => timers.forEach(clearTimeout);
  }, [focused, renaming, visible, rowId, windowId]);
  return (
    <View
      {...props}
      ref={(view) => {
        ref.current = view;
        if (legacyId) registerRow(windowId, legacyId, view);
      }}
      accessible={visible && !renaming}
      accessibilityElementsHidden={!visible}
      focusable={focused && !renaming}
      enableFocusRing={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      onLayout={(event) => {
        props.onLayout?.(event);
        if (focused && ref.current) revealers.get(windowId)?.(ref.current);
      }}
    >
      {children}
      {focused ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: 10, borderWidth: 2, borderColor: theme.accent }]} /> : null}
    </View>
  );
}

export function useSidebarKeyboard(windowId: string, scroll: RefObject<ScrollView | null>, scrollY: RefObject<number>, glowRoom: number) {
  useEffect(() => {
    let renaming = false;
    const page = () => {
      blurSidebar(windowId);
      const s = useBrowser.getState();
      const id = activeTabId(s, windowId);
      if (id) void webviews.get(id)?.focus();
    };
    const tabId = (row: SidebarKeyboardRow) => {
      const s = useBrowser.getState();
      const active = activeTabId(s, windowId);
      return row.tabIds.includes(active ?? "") ? active : row.tabIds[0];
    };
    const restore = () => {
      renaming = false;
      focusSidebar(windowId);
    };
    const unregister = registerSidebarKeyboardActions(
      windowId,
      {
        open(row) {
          dismissHover();
          if (row.kind === "liveItem") openLiveItem(windowId, row.folderId!, row.item!);
          else {
            const id = tabId(row);
            if (id) clickTab(windowId, id);
          }
          page();
        },
        peek(row) {
          if (row.kind === "folder" || row.kind === "group") {
            void measureRow(windowId, row.id.slice(2)).then((anchor) => {
              if (anchor && useSidebarUi.getState().keyboard[windowId]?.rowId === row.id && useSidebarUi.getState().keyboard[windowId]?.active) {
                setSidebarUi({ hover: { windowId, kind: row.kind as "folder" | "group", id: row.id.slice(2), anchor } });
              }
            });
            return;
          }
          const s = useBrowser.getState();
          const from = activeTabId(s, windowId);
          const id = tabId(row);
          const url = row.item?.url ?? (id ? s.tabs[id]?.url : undefined);
          if (from && url) {
            s.openPeek(from, url);
            // The peek takes focus when mounted. Keep Escape on the page's existing peek handler.
            blurSidebar(windowId);
          }
        },
        close(row) {
          const ids =
            row.kind === "liveFolder"
              ? Object.values(useBrowser.getState().tabs)
                  .filter((t) => t.liveItem?.folderId === row.folderId && t.windowId === windowId)
                  .map((t) => t.id)
              : row.tabIds;
          for (const id of ids) void closeTab(id);
        },
        rename(row) {
          if (row.kind === "liveFolder") {
            const folder = live().folders[row.folderId!];
            if (!folder) return;
            renaming = true;
            void prompt({ title: "Rename Live Folder", value: folder.name, placeholder: "Live folder name", confirmTitle: "Rename", windowId }).then((name) => {
              if (name?.trim()) updateFolder(folder.id, { name: name.trim() }, windowId);
              restore();
            });
          } else {
            const id = tabId(row);
            if (row.kind !== "folder" && row.kind !== "group" && !id) return;
            const target = row.kind === "folder" || row.kind === "group" ? { kind: row.kind, id: row.id.slice(2) } : { kind: "tab" as const, id: id! };
            renaming = true;
            void startRename(windowId, target).then(() => {
              if (!useSidebarUi.getState().renaming) restore();
            });
          }
        },
        focusPage: page,
      },
      () => reconcileSidebarKeyboard(windowId),
    );
    const reveal = (view: View) => {
      const viewport = scroll.current;
      if (!viewport) return;
      view.measureInWindow((_x, y, width, height) => {
        if (!width || !height || scroll.current !== viewport) return;
        viewport.getNativeScrollRef()?.measureInWindow((_sx, sy, _sw, sh) => {
          const top = sy + glowRoom + 3;
          const bottom = sy + sh - 3;
          const delta = y < top ? y - top : y + height > bottom ? y + height - bottom : 0;
          if (sh > 0 && delta) viewport.scrollTo({ y: Math.max(0, scrollY.current + delta), animated: false });
        });
      });
    };
    revealers.set(windowId, reveal);
    const unsub = useBrowser.subscribe((s, prev) => {
      if (!s.windows[windowId]) return;
      if (s.windows[windowId]?.spaceId !== prev.windows[windowId]?.spaceId) blurSidebar(windowId);
      if (s.windowUi[windowId]?.panel.open || !s.windows[windowId]?.sidebarOpen) blurSidebar(windowId);
      if (
        s.tabs !== prev.tabs ||
        s.windows !== prev.windows ||
        s.pinnedFolders !== prev.pinnedFolders ||
        s.groups !== prev.groups ||
        s.spaces !== prev.spaces ||
        s.splits !== prev.splits ||
        s.tabLists !== prev.tabLists
      )
        reconcileSidebarKeyboard(windowId);
    });
    const unsubLive = useLive.subscribe(() => reconcileSidebarKeyboard(windowId));
    const unsubUi = useSidebarUi.subscribe((s, prev) => {
      if (renaming && prev.renaming?.windowId === windowId && !s.renaming) restore();
    });
    return () => {
      unregister();
      unsub();
      unsubLive();
      unsubUi();
      if (revealers.get(windowId) === reveal) revealers.delete(windowId);
    };
  }, [windowId, scroll, scrollY, glowRoom]);
}
