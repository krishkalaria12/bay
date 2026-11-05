import { ContextMenuArea, Symbol } from "@bay/desktop";
import type { ReactNode } from "react";
import { Pressable, ScrollView, View } from "@bay/platform";
import { Text } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { createSpace, switchSpace } from "../../lib/actions";
import { reportBrowserCommand } from "../../runtime/commands";
import { activate } from "../../runtime/tabActions";
import { switchSpace as switchSpaceCommand } from "../../runtime/windowActions";
import { useTheme } from "../../lib/theme";
import { useBrowserRead as useBrowser } from "../../store/read";
import { childFolderIds } from "../../store/folders";
import { spaceTabIds } from "../../store/model";
import type { Tab } from "../../store/types";
import { EmptyState, matchesQuery } from "../pages/PageLayout";
import { Favicon, IconButton, useHover } from "../ui/primitives";
import { tabTitle } from "../sidebar/actions";
import { useSidebarTokens } from "../sidebar/tokens";
import { SpaceGlyph } from "../spaces/SpaceGlyph";
import { openSpaceMenu } from "../spaces/SpaceSwitcher";
import { libraryTabMenu } from "./actions";
import { SPACE_COLUMN, SPACE_COLUMN_GAP, SPACES_PAD } from "./sidebarState";
import { publicSpaceIds } from "./spaces";

const ROW = 36;

// Arc's Library › Spaces: the spaces side by side, a column each with its pinned tabs and folders over a line and
// its open tabs below, and a + for a new one after them.
export function LibrarySpaces({ windowId, query }: { windowId: string; query: string }) {
  const { spaces, spaceOrder, tabs, tabLists, pinnedFolders, windows } = useBrowser(
    useShallow((s) => ({
      spaces: s.spaces,
      spaceOrder: s.spaceOrder,
      tabs: s.tabs,
      tabLists: s.tabLists,
      pinnedFolders: s.pinnedFolders,
      windows: s.windows,
    })),
  );
  const columns = publicSpaceIds({ spaces, spaceOrder })
    .map((id) => {
      const space = spaces[id]!;
      const all = spaceTabIds({ spaces, tabs, tabLists }, id)
        .map((t) => tabs[t]!)
        .filter((tab) => !windows[tab.windowId]?.incognito && !tab.folderId);
      const shown = all.filter((tab) => matchesQuery(query, tabTitle(tab), tab.url, space.name));
      const folders = childFolderIds({ pinnedFolders }, null, id)
        .map((f) => pinnedFolders[f]!)
        .filter((f) => matchesQuery(query, f.name, space.name));
      return { space, folders, pinned: shown.filter((t) => t.pinned || t.pinnedRow), open: shown.filter((t) => !t.pinned && !t.pinnedRow) };
    })
    .filter((c) => !query || matchesQuery(query, c.space.name) || c.folders.length || c.pinned.length || c.open.length);
  if (!columns.length) return <EmptyState title="No matching spaces or tabs" subtitle="Try a space name, tab title, or website." />;
  return (
    <ScrollView
      horizontal
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingHorizontal: SPACES_PAD, paddingBottom: SPACES_PAD, gap: SPACE_COLUMN_GAP, alignItems: "stretch" }}
    >
      {columns.map(({ space, folders, pinned, open }) => (
        <SpaceColumn key={space.id} windowId={windowId} spaceId={space.id} name={space.name} folders={folders} pinned={pinned} open={open} />
      ))}
      <View style={{ justifyContent: "center", paddingHorizontal: 8 }}>
        <IconButton icon="plus" size={14} box={32} radius={16} tooltip="New Space" onPress={() => void newSpace(windowId)} />
      </View>
    </ScrollView>
  );
}

async function newSpace(windowId: string) {
  const id = await createSpace(windowId);
  if (id) switchSpace(windowId, id);
}

function SpaceColumn({
  windowId,
  spaceId,
  name,
  folders,
  pinned,
  open,
}: {
  windowId: string;
  spaceId: string;
  name: string;
  folders: { id: string; name: string }[];
  pinned: Tab[];
  open: Tab[];
}) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const showTab = (tab: Tab) => {
    reportBrowserCommand(switchSpaceCommand(windowId, spaceId).then(() => activate(tab.id, windowId)));
  };
  const tabRow = (tab: Tab) => (
    <ContextMenuArea key={tab.id} onContextMenu={() => void libraryTabMenu(windowId, tab)}>
      <ColumnRow title={tabTitle(tab)} icon={<Favicon url={tab.url} favicon={tab.favicon} spaceId={tab.spaceId} />} onPress={() => showTab(tab)} />
    </ContextMenuArea>
  );
  return (
    <View style={{ width: SPACE_COLUMN, borderRadius: 12, backgroundColor: tokens.groupFill, overflow: "hidden" }}>
      <View style={{ height: 44, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 12, paddingRight: 6 }}>
        <Pressable
          accessibilityLabel={`Open ${name}`}
          onPress={() => switchSpace(windowId, spaceId)}
          style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8 }}
        >
          <SpaceGlyph spaceId={spaceId} size={16} />
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, fontWeight: "600", color: theme.textPrimary }}>
            {name}
          </Text>
        </Pressable>
        <IconButton icon="ellipsis" size={12} box={26} tooltip="Space Actions" onPress={() => void openSpaceMenu(windowId, spaceId)} />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 6, paddingBottom: 8 }}>
        {folders.map((f) => (
          <ColumnRow
            key={f.id}
            title={f.name || "New Folder"}
            bold
            icon={<Symbol name="folder" size={14} color={theme.textSecondary} style={{ width: 18, height: 16 }} />}
            onPress={() => switchSpace(windowId, spaceId)}
          />
        ))}
        {pinned.map(tabRow)}
        {(folders.length || pinned.length) && open.length ? (
          <View style={{ height: 1, marginHorizontal: 8, marginVertical: 6, backgroundColor: tokens.separator }} />
        ) : null}
        {open.map(tabRow)}
        {!folders.length && !pinned.length && !open.length ? (
          <Text style={{ padding: 8, fontSize: 12, color: theme.textTertiary }}>No tabs in this space</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

function ColumnRow({ title, icon, bold, onPress }: { title: string; icon: ReactNode; bold?: boolean; onPress: () => void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps} style={{ borderRadius: 8, backgroundColor: hovered ? theme.rowHover : undefined }}>
      <Pressable onPress={onPress} style={{ height: ROW, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 8 }}>
        {icon}
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, fontWeight: bold ? "600" : "400", color: theme.textPrimary }}>
          {title}
        </Text>
      </Pressable>
    </View>
  );
}
