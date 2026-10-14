import { ContextMenuArea, FadeLabel, Surface, Symbol } from "@bay/shell";
import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { hex, useTheme } from "../../lib/theme";
import { layout, SYMBOL_PREFIX } from "../../lib/constants";
import { useBrowser } from "../../store/browser";
import { usePageSpaceId, useWindowId } from "../../store/hooks";
import { commitRename, endRename, startRename } from "./actions";
import { useDragItem, useDropInto } from "./dnd";
import { Fold, useFold } from "./Fold";
import { keptEntry } from "./geometry";
import { FOLDER_INDENT } from "./constants";
import { useFolderEntries } from "./entries";
import { dismissHover, useRowHover } from "./hover";
import { openFolderMenu } from "./menus";
import { registerRow, useSidebarUi } from "./state";
import { TabIcon } from "./TabIcon";
import { RenameField, TabRowItem } from "./TabRow";
import { useSidebarMetrics, useSidebarTokens, withAlpha } from "./tokens";
import { folderTabIds } from "../../store/folders";

/**
 * A folder of the Pinned section (Arc's, Zen's): a header row with its name, and its pinned rows indented below it.
 * No box around it, unlike a group's. Collapsed, it keeps the window's active tab out, as a group does.
 */
export const FolderBlock = memo(function FolderBlock({ folderId }: { folderId: string }) {
  const metrics = useSidebarMetrics();
  const windowId = useWindowId();
  const spaceId = usePageSpaceId();
  const collapsed = useBrowser((s) => !!s.pinnedFolders[folderId]?.collapsed);
  const entries = useFolderEntries(folderId);
  const selectedInside = useBrowser((s) => {
    const selection = s.selection[windowId];
    return !!selection?.length && entries.some((e) => selection.includes(e.slice(2)));
  });
  const activeEntry = useBrowser((s) => keptEntry(s, windowId, spaceId, entries));
  const tabIds = entries.map((e) => e.slice(2));
  const { ref, style, handle, headerRef } = useDragItem(`f:${folderId}`, { kind: "folder", tabIds, section: "pinned", folderId, collapsed });
  const { ref: tailRef, style: tailStyle } = useDragItem(`tail:folder:${folderId}`, { kind: "tail", tabIds: [], section: "pinned", parentGroup: folderId });
  const fold = useFold(collapsed);

  return (
    <Animated.View ref={ref} style={style}>
      <View ref={headerRef} {...handle}>
        <FolderHeader folderId={folderId} windowId={windowId} collapsed={collapsed} open={fold.open} />
      </View>
      <View style={{ paddingLeft: FOLDER_INDENT }}>
        <Fold
          fold={fold}
          collapsed={collapsed}
          entries={entries.map((entry) => ({ key: entry, node: <TabRowItem tabId={entry.slice(2)} section="pinned" parentGroup={folderId} /> }))}
          keep={activeEntry}
          gap={layout.rowGap}
          rowHeight={metrics.rowHeight}
          padTop={entries.length ? layout.rowGap : 0}
          mountClosed={selectedInside}
          footer={<Animated.View ref={tailRef} style={tailStyle} />}
        />
        {!entries.length && !collapsed ? <EmptyFolder /> : null}
      </View>
    </Animated.View>
  );
});

// yab's line under an open folder with nothing in it (a drop there lands in the folder).
function EmptyFolder() {
  const metrics = useSidebarMetrics();
  const theme = useTheme();
  return (
    <View pointerEvents="none" style={{ height: metrics.rowHeight, marginTop: layout.rowGap, justifyContent: "center", paddingLeft: 9 }}>
      <Text numberOfLines={1} style={{ fontSize: 13, color: theme.textTertiary }}>
        Drag tabs here
      </Text>
    </View>
  );
}

// `open` is the rows' collapse animation: the chevron turns on its frames.
function FolderHeader({ folderId, windowId, collapsed, open }: { folderId: string; windowId: string; collapsed: boolean; open: SharedValue<number> }) {
  const metrics = useSidebarMetrics();
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const folder = useBrowser((s) => s.pinnedFolders[folderId]);
  const empty = useBrowser((s) => !folderTabIds(s, folderId).length);
  const renaming = useSidebarUi((u) => u.renaming?.kind === "folder" && u.renaming.id === folderId);
  const dropInto = useDropInto() === folderId;
  // A closed folder peeks its tabs on hover (Arc's folder previews); an open one shows them already.
  const { hovered, hoverProps } = useRowHover(windowId, collapsed && !renaming && !empty ? { kind: "folder", id: folderId } : null);
  const chevron = useAnimatedStyle(() => ({ transform: [{ rotate: `${(open.get() - 1) * 90}deg` }] }));
  if (!folder) return null;
  const target = { kind: "folder" as const, id: folderId };
  const label = folder.name || "New Folder";

  return (
    <View ref={(v) => registerRow(windowId, folderId, v)} {...hoverProps} onDoubleClick={() => void startRename(windowId, target)}>
      <ContextMenuArea
        onContextMenu={() => {
          dismissHover();
          void openFolderMenu(windowId, folderId);
        }}
      >
        <Pressable
          onPress={() => {
            dismissHover();
            if (!renaming) useBrowser.getState().updatePinnedFolder(folderId, { collapsed: !collapsed });
          }}
        >
          {({ pressed }) => (
            <Surface
              fill={hex(dropInto || pressed ? theme.tabPressed : hovered ? theme.tabHover : "rgba(0,0,0,0)")}
              cornerRadius={10}
              style={{ height: metrics.rowHeight, flexDirection: "row", alignItems: "center", paddingLeft: 9, paddingRight: 6 }}
            >
              <TabIcon url="" icon={folder.icon ?? `${SYMBOL_PREFIX}${collapsed ? "folder.fill" : "folder"}`} color={folder.icon ? undefined : theme.textTab} />
              {renaming ? (
                <RenameField
                  initial={folder.name}
                  placeholder="Folder name"
                  color={theme.textPrimary}
                  weight="500"
                  onDone={(text) => (text === null ? endRename(target) : commitRename(target, text))}
                />
              ) : (
                <View style={{ flex: 1, height: 18, marginLeft: 5, flexDirection: "row", alignItems: "center" }}>
                  {/* The name is as wide as its (transparent) text: the chevron follows it from the first frame. */}
                  <View style={{ flexShrink: 1, height: 18, paddingRight: 8, justifyContent: "center" }}>
                    <Text numberOfLines={1} style={{ opacity: 0, fontSize: 13, fontWeight: "500" }}>
                      {label}
                    </Text>
                    <FadeLabel
                      text={label}
                      fontSize={13}
                      weight="medium"
                      color={theme.textTab}
                      style={{ position: "absolute", left: 0, right: 0, top: 0, height: 18 }}
                    />
                  </View>
                  {empty ? null : (
                    <Animated.View style={[{ width: 10, height: 10, alignItems: "center", justifyContent: "center" }, chevron]}>
                      <Symbol name="chevron.down" size={9} weight="semibold" color={withAlpha(tokens.groupTitle, 0.5)} style={{ width: 10, height: 10 }} />
                    </Animated.View>
                  )}
                </View>
              )}
            </Surface>
          )}
        </Pressable>
      </ContextMenuArea>
    </View>
  );
}
