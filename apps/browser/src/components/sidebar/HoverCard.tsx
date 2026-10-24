import { Pressable, View, capabilities } from "@bay/platform";
import { FadeLabel, Surface, Symbol } from "@bay/shell";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Image, Text } from "react-native";
import { displayUrl, hostOf } from "@bay/core";
import { hex, useTheme } from "../../lib/theme";
import { besideRow, useSidebarOnRight } from "../layout/windowLayout";
import { useBrowserRead as useBrowser } from "../../store/read";
import { activeTabId, isIncognitoSpace } from "../../store/model";
import { splitOf } from "../../store/splits";
import { lastPicture } from "../../lib/tabPictures";
import { awayFromPin, groupLabel } from "../../store/organize";
import { CalendarPreview, useIsCalendarTab } from "../live/CalendarPreview";
import { LiveItemCard } from "../live/LiveItemCard";
import { useIsSleeping } from "../../lib/tabLifecycle";
import { clickTab, tabTitle } from "./actions";
import { dismissHover, hoverLeave, keepHover } from "./hover";
import { useSidebarUi, type Anchor } from "./state";
import { TabIcon } from "./TabIcon";
import { HoverPlayer, useShowsMiniPlayer } from "../media/HoverPlayer";
import { SitePreview, useSitePreview } from "../previews/SitePreview";
import { folderTabIds } from "../../store/folders";
import { HOVER_CARD_PAD, HOVER_CARD_PEEK_ROWS, HOVER_CARD_PREVIEW_HEIGHT, HOVER_CARD_WIDTH } from "./constants";

export function HoverCard({ windowId, windowWidth }: { windowId: string; windowWidth: number }) {
  const hover = useSidebarUi((u) => (u.hover?.windowId === windowId ? u.hover : null));
  const player = useShowsMiniPlayer(hover?.kind === "tab" ? hover.id : undefined);
  const calendar = useIsCalendarTab(hover?.kind === "tab" ? hover.id : null);
  const site = useSitePreview(hover?.kind === "tab" ? hover.id : undefined);
  const folders = useBrowser((s) => s.settings.previewFolders);
  if (!hover) return null;
  if (hover.kind === "live") return <LiveItemCard id={hover.id} windowId={windowId} anchor={hover.anchor} />;
  if (hover.kind === "tab" && player) return <HoverPlayer tabId={hover.id} windowId={windowId} anchor={hover.anchor} windowWidth={windowWidth} />;
  if (capabilities.calendar && hover.kind === "tab" && calendar) return <CalendarPreview tabId={hover.id} windowId={windowId} anchor={hover.anchor} />;
  if (hover.kind === "tab" && site) return <SitePreview key={hover.id} tabId={hover.id} site={site} anchor={hover.anchor} />;
  if (hover.kind === "tab") return <TabCard tabId={hover.id} windowId={windowId} anchor={hover.anchor} />;
  if (!folders) return null;
  return hover.kind === "folder" ? (
    <FolderPeek folderId={hover.id} windowId={windowId} anchor={hover.anchor} />
  ) : (
    <GroupPeek groupId={hover.id} windowId={windowId} anchor={hover.anchor} />
  );
}

function Card({ anchor, children }: { anchor: Anchor; children: React.ReactNode }) {
  const theme = useTheme();
  const right = useSidebarOnRight();
  return (
    <Surface
      onMouseEnter={keepHover}
      onMouseLeave={hoverLeave}
      fill={hex(theme.panel)}
      cornerRadius={12}
      borderColor={hex(theme.panelBorder)}
      borderWidth={0.5}
      shadowColor="#000000"
      shadowOpacity={theme.panelShadowOpacity * 0.8}
      shadowRadius={16}
      shadowOffset={[0, 6]}
      style={{
        position: "absolute",
        left: besideRow(anchor, HOVER_CARD_WIDTH, right),
        top: Math.max(8, anchor.y - 6),
        width: HOVER_CARD_WIDTH,
        padding: HOVER_CARD_PAD,
      }}
    >
      {children}
    </Surface>
  );
}

function TabCard({ tabId, windowId, anchor }: { tabId: string; windowId: string; anchor: Anchor }) {
  const theme = useTheme();
  const tab = useBrowser((s) => s.tabs[tabId]);
  const sleeping = useIsSleeping(tabId);
  // The page on screen (the shown tab, or one in its split) needs no preview: just what it is and where.
  const onScreen = useBrowser((s) => {
    const active = activeTabId(s, windowId);
    return active === tabId || !!(active && splitOf(s, active)?.tabIds.includes(tabId));
  });
  if (!tab) return null;
  const away = !onScreen && awayFromPin(tab);
  return (
    <Card anchor={anchor}>
      {!onScreen && tab.url ? <PagePreview tabId={tabId} /> : null}
      <Text numberOfLines={2} style={{ fontSize: 13, lineHeight: 17, fontWeight: "500", color: theme.textPrimary }}>
        {tabTitle(tab)}
      </Text>
      {tab.url ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 5 }}>
          <TabIcon tabId={tabId} url={tab.url} favicon={tab.favicon} icon={tab.customIcon} size={14} />
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: theme.textSecondary }}>
            {hostOf(tab.url) || displayUrl(tab.url)}
          </Text>
        </View>
      ) : null}
      {!onScreen && sleeping ? (
        <View accessible accessibilityLabel="Web content has been discarded" style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 }}>
          <Symbol name="moon.zzz" size={10} color={theme.textTertiary} style={{ width: 14, height: 14 }} />
          <Text style={{ fontSize: 11.5, color: theme.textTertiary }}>This tab needs to reload</Text>
        </View>
      ) : null}
      {away && tab.pinnedUrl ? (
        <Text numberOfLines={1} style={{ marginTop: 2, fontSize: 11.5, color: theme.textTertiary }}>
          Pinned: {displayUrl(tab.pinnedUrl)}
        </Text>
      ) : null}
    </Card>
  );
}

// What's on a background tab's page: its last picture (tabPictures.ts: a page out of view isn't painted, so it can't
// be captured now). Never for a private window's tabs. Nothing until there's one.
function PagePreview({ tabId }: { tabId: string }) {
  const theme = useTheme();
  const incognito = useBrowser((s) => isIncognitoSpace(s.tabs[tabId]?.spaceId ?? ""));
  const picture = incognito ? null : lastPicture(tabId);
  if (!picture) return null;
  const [, , width, height] = picture.frame;
  // The page's top, at the card's width: the image keeps its shape and the frame crops the rest.
  const shown = width > 0 ? (HOVER_CARD_WIDTH * height) / width : HOVER_CARD_PREVIEW_HEIGHT;
  return (
    <View
      style={{
        height: Math.min(HOVER_CARD_PREVIEW_HEIGHT, shown),
        margin: -HOVER_CARD_PAD,
        marginBottom: HOVER_CARD_PAD,
        overflow: "hidden",
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
        borderBottomWidth: 0.5,
        borderBottomColor: theme.panelBorder,
      }}
    >
      <Image source={{ uri: `data:image/jpeg;base64,${picture.data}` }} style={{ width: HOVER_CARD_WIDTH, height: shown }} accessibilityIgnoresInvertColors />
    </View>
  );
}

function GroupPeek({ groupId, windowId, anchor }: { groupId: string; windowId: string; anchor: Anchor }) {
  const group = useBrowser((s) => s.groups[groupId]);
  const label = useBrowser((s) => (s.groups[groupId] ? groupLabel(s, s.groups[groupId]!) : ""));
  if (!group) return null;
  return <Peek label={label} tabIds={group.tabIds} windowId={windowId} anchor={anchor} />;
}

// A closed pinned folder's tabs, as Arc's folder previews show them.
function FolderPeek({ folderId, windowId, anchor }: { folderId: string; windowId: string; anchor: Anchor }) {
  const name = useBrowser((s) => s.pinnedFolders[folderId]?.name);
  const tabIds = useBrowser(useShallow((s) => folderTabIds(s, folderId)));
  if (name === undefined || !tabIds.length) return null;
  return <Peek label={name || "New Folder"} tabIds={tabIds} windowId={windowId} anchor={anchor} />;
}

function Peek({ label, tabIds, windowId, anchor }: { label: string; tabIds: readonly string[]; windowId: string; anchor: Anchor }) {
  const theme = useTheme();
  const more = tabIds.length - HOVER_CARD_PEEK_ROWS;
  return (
    <Card anchor={anchor}>
      <Text style={{ fontSize: 12, fontWeight: "600", color: theme.textSecondary, marginBottom: 4, marginLeft: 4 }}>
        {label} · {tabIds.length === 1 ? "1 tab" : `${tabIds.length} tabs`}
      </Text>
      {tabIds.slice(0, HOVER_CARD_PEEK_ROWS).map((id) => (
        <PeekRow key={id} tabId={id} windowId={windowId} />
      ))}
      {more > 0 ? <Text style={{ fontSize: 11.5, color: theme.textTertiary, marginTop: 4, marginLeft: 4 }}>and {more} more</Text> : null}
    </Card>
  );
}

function PeekRow({ tabId, windowId }: { tabId: string; windowId: string }) {
  const theme = useTheme();
  const tab = useBrowser((s) => s.tabs[tabId]);
  const [hovered, setHovered] = useState(false);
  if (!tab) return null;
  return (
    <Pressable
      onPress={() => {
        dismissHover();
        clickTab(windowId, tabId);
      }}
    >
      <View
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          height: 28,
          borderRadius: 7,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 5,
          backgroundColor: hovered ? theme.rowHover : undefined,
        }}
      >
        <TabIcon url={tab.url} favicon={tab.favicon} icon={tab.customIcon} size={14} spaceId={tab.spaceId} />
        <FadeLabel text={tabTitle(tab)} fontSize={12.5} color={theme.textTab} style={{ flex: 1, height: 17, marginLeft: 7 }} />
      </View>
    </Pressable>
  );
}
