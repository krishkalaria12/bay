import {
  ContextMenuArea,
  copyCaptureImage,
  fileExists,
  MouseArea,
  openFile,
  pickFiles,
  saveCaptureImage,
  shareCaptureImage,
  showMenu,
  Symbol,
} from "@bay/shell";
import { useEffect, useState, type ReactNode } from "react";
import { LegendList } from "@legendapp/list/react-native";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { isIncognitoSpace, spaceTabIds } from "../../store/model";
import type { Tab, TabSnapshot } from "../../store/types";
import { openUrl } from "../bookmarks/actions";
import { showToast } from "../layout/splitActions";
import { DownloadsPage } from "../pages/DownloadsPage";
import { EmptyState, hostLabel, matchesQuery } from "../pages/PageLayout";
import { Favicon, IconButton, useHover } from "../primitives";
import { Button, SearchField, useFormColors } from "../settings/controls";
import { tabTitle } from "../sidebar/actions";
import { SpaceGlyph } from "../spaces/SpaceGlyph";
import { chooseEasel, easelMenu, libraryWindow, newEasel, openEasel } from "./actions";
import type { EaselDocument, LibraryMedia } from "./model";
import { removeLibraryMedia, saveLibraryMedia, startLibrary, useLibrary } from "./state";

const SECTIONS = [
  { id: "media", title: "Media", icon: "photo.on.rectangle" },
  { id: "downloads", title: "Downloads", icon: "arrow.down.circle" },
  { id: "easels", title: "Easels", icon: "rectangle.on.rectangle" },
  { id: "spaces", title: "Spaces", icon: "square.stack" },
  { id: "archive", title: "Archived Tabs", icon: "archivebox" },
] as const;
type Section = (typeof SECTIONS)[number]["id"];
function sectionOf(value?: string): Section {
  if (value === "archived-tabs" || value === "archived") return "archive";
  return SECTIONS.find((section) => section.id === value)?.id ?? "media";
}
const fileUri = (path: string) => `file://${path.split("/").map(encodeURIComponent).join("/")}`;

export function LibraryPage({ tabId, initialSection }: { tabId: string; initialSection?: string }) {
  const window = useBrowser((s) => s.windows[s.tabs[tabId]?.windowId ?? ""]);
  if (!window || window.incognito || isIncognitoSpace(window.spaceId)) {
    return (
      <View style={{ flex: 1, padding: 24 }}>
        <LibraryTitle />
        <EmptyState
          title="Library is available in regular windows"
          subtitle="Media and Easels are saved on this Mac. Open a regular window to use your Library."
        />
      </View>
    );
  }
  return <PublicLibrary key={window.id} tabId={tabId} windowId={window.id} initialSection={initialSection} />;
}

function LibraryTitle() {
  const theme = useTheme();
  return <Text style={{ fontSize: 22, fontWeight: "600", color: theme.textPrimary }}>Library</Text>;
}

function PublicLibrary({ tabId, windowId, initialSection }: { tabId: string; windowId: string; initialSection?: string }) {
  const colors = useFormColors();
  const [section, setSection] = useState(() => sectionOf(initialSection));
  const [query, setQuery] = useState("");
  const [width, setWidth] = useState(600);
  const [importing, setImporting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const error = useLibrary((s) => s.error);
  const loaded = useLibrary((s) => s.loaded);
  useEffect(() => startLibrary(), []);
  useEffect(() => {
    setSection(sectionOf(initialSection));
    setQuery("");
  }, [initialSection]);
  const compact = width < 540;
  const current = SECTIONS.find((s) => s.id === section)!;

  async function importImages() {
    setImporting(true);
    setActionError(null);
    let failed = 0;
    try {
      failed = await importMediaFiles(windowId);
    } catch (error) {
      setActionError(`Couldn't import images: ${String(error)}`);
    }
    if (failed)
      setActionError(`${failed === 1 ? "One file couldn't" : `${failed} files couldn't`} be imported. Choose image files that are available on this Mac.`);
    setImporting(false);
  }

  return (
    <View style={{ flex: 1 }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <View style={{ minHeight: 64, paddingHorizontal: 24, paddingVertical: 16, flexDirection: "row", alignItems: "center", gap: 16 }}>
        <LibraryTitle />
        {!compact && section !== "downloads" ? (
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={`Search ${current.title.toLowerCase()}`}
            style={{ flex: 1, maxWidth: 480, marginLeft: 8 }}
          />
        ) : (
          <View style={{ flex: 1 }} />
        )}
        {section === "media" ? (
          <Button title={importing ? "Importing…" : "Import Images…"} disabled={importing || !loaded || !!error} onPress={() => void importImages()} />
        ) : null}
        {section === "easels" ? <Button title="New Easel" icon="plus" disabled={!loaded || !!error} onPress={() => newEasel(windowId)} /> : null}
      </View>
      <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator, paddingBottom: 12, gap: 12 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 24, gap: 4 }}>
          {SECTIONS.map((item) => (
            <SectionButton
              key={item.id}
              title={item.title}
              icon={item.icon}
              selected={section === item.id}
              onPress={() => {
                setSection(item.id);
                setQuery("");
              }}
            />
          ))}
        </ScrollView>
        {compact && section !== "downloads" ? (
          <SearchField value={query} onChangeText={setQuery} placeholder={`Search ${current.title.toLowerCase()}`} style={{ marginHorizontal: 24 }} />
        ) : null}
      </View>
      {error || actionError ? (
        <Text selectable style={{ paddingHorizontal: 24, paddingVertical: 12, fontSize: 13, color: colors.destructive }}>
          {error || actionError}
        </Text>
      ) : null}
      {section === "downloads" ? (
        <DownloadsPage tabId={tabId} />
      ) : section === "spaces" ? (
        <SpacesSection windowId={windowId} query={query} />
      ) : section === "archive" ? (
        <ArchiveSection windowId={windowId} query={query} />
      ) : !loaded ? (
        <EmptyState title="Loading Library…" />
      ) : section === "media" ? (
        <MediaSection windowId={windowId} query={query} width={width} />
      ) : (
        <EaselsSection windowId={windowId} query={query} width={width} />
      )}
    </View>
  );
}

async function importMediaFiles(windowId: string) {
  const files = await pickFiles();
  let failed = 0;
  for (const file of files) {
    if (!libraryWindow(windowId)) break;
    try {
      const path = file.startsWith("file://") ? decodeURIComponent(new URL(file).pathname) : file;
      const media = await saveLibraryMedia({ path, width: 1, height: 1 }, path.split("/").pop() || "Image");
      if (!media) failed++;
    } catch {
      failed++;
    }
  }
  return failed;
}

function SectionButton({ title, icon, selected, onPress }: { title: string; icon: string; selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  const colors = useFormColors();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps}>
      <Pressable
        accessibilityRole="tab"
        accessibilityState={{ selected }}
        onPress={onPress}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          height: 28,
          paddingHorizontal: 10,
          borderRadius: 7,
          backgroundColor: selected ? colors.selected : hovered ? theme.rowHover : undefined,
        }}
      >
        <Symbol name={icon} size={12} color={selected ? theme.textPrimary : theme.textSecondary} style={{ width: 15, height: 16 }} />
        <Text style={{ fontSize: 12.5, fontWeight: selected ? "600" : "400", color: selected ? theme.textPrimary : theme.textSecondary }}>{title}</Text>
      </Pressable>
    </View>
  );
}

function gridSize(width: number) {
  const columns = Math.max(1, Math.floor((width - 48 + 16) / 220));
  return { columns, cardWidth: Math.max(1, (width - 48 - (columns - 1) * 16) / columns) };
}

// A grid's cell: half the 16 pt gap each side and 20 below, in a list padded 16 (24 at its edges with the cells').
// The cell, not the list, spaces the cards, so a card is exactly gridSize's width in its column.
const GRID_CONTENT = { paddingHorizontal: 16, paddingTop: 24, paddingBottom: 20 };
const GRID_CELL = { paddingHorizontal: 8, paddingBottom: 20 };

function MediaSection({ windowId, query, width }: { windowId: string; query: string; width: number }) {
  const media = useLibrary((s) => s.media);
  const shown = Object.values(media)
    .filter((m) => !m.source?.profileId || !isIncognitoSpace(m.source.profileId))
    .filter((m) => matchesQuery(query, m.name, m.source?.title ?? "", m.source?.url ?? ""))
    .sort((a, b) => b.createdAt - a.createdAt);
  const { columns, cardWidth } = gridSize(width);
  if (!shown.length)
    return (
      <EmptyState
        title={query ? "No matching media" : "Your saved images appear here"}
        subtitle={query ? "Try a different name or source." : "Import images or save a capture to Library."}
      />
    );
  return (
    <LegendList
      key={columns}
      style={{ flex: 1 }}
      data={shown}
      numColumns={columns}
      keyExtractor={(m) => m.id}
      contentContainerStyle={GRID_CONTENT}
      renderItem={({ item }) => (
        <View style={GRID_CELL}>
          <MediaCard media={item} windowId={windowId} width={cardWidth} />
        </View>
      )}
    />
  );
}

function MediaCard({ media, windowId, width }: { media: LibraryMedia; windowId: string; width: number }) {
  const theme = useTheme();
  const colors = useFormColors();
  const [broken, setBroken] = useState(false);
  const available = !broken && fileExists(media.path);
  return (
    <View style={{ width, gap: 8 }}>
      <MouseArea path={available ? media.path : null}>
        <ContextMenuArea onContextMenu={() => void mediaMenu(media, windowId)}>
          <Pressable
            accessibilityLabel={`Open ${media.name}`}
            disabled={!available}
            onPress={() => void openMediaFile(media, windowId)}
            style={{
              height: 174,
              borderRadius: 10,
              overflow: "hidden",
              backgroundColor: colors.group,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.groupBorder,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {available ? (
              <Image
                source={{ uri: fileUri(media.path) }}
                resizeMode="contain"
                onError={() => setBroken(true)}
                accessibilityIgnoresInvertColors
                style={{ width: "100%", height: "100%" }}
              />
            ) : (
              <View style={{ alignItems: "center", gap: 8 }}>
                <Symbol name="photo" size={24} color={theme.textTertiary} style={{ width: 28, height: 28 }} />
                <Text style={{ fontSize: 12, color: theme.textSecondary }}>Image unavailable</Text>
              </View>
            )}
          </Pressable>
        </ContextMenuArea>
      </MouseArea>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: "500", color: theme.textPrimary }}>
            {media.name}
          </Text>
          <Text numberOfLines={1} style={{ fontSize: 11.5, color: theme.textTertiary }}>
            {available ? (media.source ? hostLabel(media.source.url) : `${media.width} × ${media.height}`) : "The file may have been moved or deleted."}
          </Text>
        </View>
        <IconButton icon="ellipsis" box={24} size={12} tooltip="Media actions" onPress={() => void mediaMenu(media, windowId)} />
      </View>
    </View>
  );
}

async function openMediaFile(media: LibraryMedia, windowId: string) {
  if (!libraryWindow(windowId)) return;
  try {
    if (!(await openFile(media.path))) throw new Error("The file may have been moved or deleted.");
  } catch (error) {
    showToast(windowId, "Couldn't Open Image", String(error));
  }
}

async function mediaMenu(media: LibraryMedia, windowId: string) {
  if (!libraryWindow(windowId)) return;
  const exists = fileExists(media.path);
  try {
    const choice = await showMenu([
      { id: "copy", title: "Copy Image", enabled: exists },
      { id: "save", title: "Save to Downloads", enabled: exists },
      { id: "share", title: "Share…", enabled: exists },
      { id: "source", title: "Open Source", enabled: !!media.source },
      { id: "easel", title: "Add to Easel…", enabled: exists && !useLibrary.getState().error },
      { separator: true },
      { id: "remove", title: "Remove from Library", enabled: !useLibrary.getState().error },
    ]);
    if (!choice || !libraryWindow(windowId)) return;
    if (choice === "copy" && !(await copyCaptureImage(media.path))) throw new Error("The image is unavailable.");
    if (choice === "save") {
      if (!(await saveCaptureImage(media.path, media.name))) throw new Error("The image couldn't be saved to Downloads.");
      showToast(windowId, "Saved to Downloads", media.name);
    }
    if (choice === "share") await shareCaptureImage(media.path, media.name, windowId);
    if (choice === "source" && media.source) openUrl(media.source.url, windowId, "foreground");
    if (choice === "easel" && !(await chooseEasel(media, windowId))) {
      const error = useLibrary.getState().error;
      if (error) throw new Error(error);
    }
    if (choice === "remove") removeLibraryMedia(media.id);
  } catch (error) {
    showToast(windowId, "Couldn't Complete Media Action", String(error));
  }
}

function EaselsSection({ windowId, query, width }: { windowId: string; query: string; width: number }) {
  const easels = useLibrary((s) => s.easels);
  const shown = Object.values(easels)
    .filter((e) => !isIncognitoSpace(e.spaceId) && matchesQuery(query, e.title))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const { columns, cardWidth } = gridSize(width);
  if (!shown.length)
    return (
      <EmptyState
        title={query ? "No matching Easels" : "Make room for your ideas"}
        subtitle={query ? "Try a different Easel title." : "Create an Easel to arrange images, links, and notes."}
      />
    );
  return (
    <LegendList
      key={columns}
      style={{ flex: 1 }}
      data={shown}
      numColumns={columns}
      keyExtractor={(e) => e.id}
      contentContainerStyle={GRID_CONTENT}
      renderItem={({ item }) => (
        <View style={GRID_CELL}>
          <EaselCard easel={item} windowId={windowId} width={cardWidth} />
        </View>
      )}
    />
  );
}

function EaselCard({ easel, windowId, width }: { easel: EaselDocument; windowId: string; width: number }) {
  const theme = useTheme();
  const colors = useFormColors();
  const visible = easel.items.filter((item) => item.kind === "image" || item.kind === "text" || item.kind === "link");
  const left = Math.min(0, ...easel.items.map((i) => i.x));
  const top = Math.min(0, ...easel.items.map((i) => i.y));
  const scale = Math.min(
    (width - 24) / Math.max(320, ...easel.items.map((i) => i.x + i.width - left)),
    150 / Math.max(200, ...easel.items.map((i) => i.y + i.height - top)),
  );
  return (
    <View style={{ width, gap: 8 }}>
      <ContextMenuArea onContextMenu={() => void easelMenu(easel.id, windowId)}>
        <Pressable
          accessibilityLabel={`Open ${easel.title}`}
          onPress={() => openEasel(easel.id, windowId)}
          style={{
            height: 174,
            borderRadius: 10,
            overflow: "hidden",
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.groupBorder,
            backgroundColor: easel.background,
          }}
        >
          <View pointerEvents="none" style={{ flex: 1 }}>
            {visible.map((item) => (
              <View
                key={item.id}
                style={{
                  position: "absolute",
                  left: 12 + (item.x - left) * scale,
                  top: 12 + (item.y - top) * scale,
                  width: item.width * scale,
                  height: item.height * scale,
                  overflow: "hidden",
                }}
              >
                {item.kind === "image" && item.path ? (
                  <EaselImage path={item.path} />
                ) : (
                  <Text style={{ color: item.color ?? "#222222", fontSize: Math.max(6, (item.fontSize ?? 18) * scale) }}>{item.text || item.url}</Text>
                )}
              </View>
            ))}
            {!easel.items.length ? (
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ fontSize: 12, color: "#777777" }}>Empty Easel</Text>
              </View>
            ) : null}
          </View>
        </Pressable>
      </ContextMenuArea>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: "500", color: theme.textPrimary }}>
            {easel.title || "Untitled Easel"}
          </Text>
          <Text style={{ fontSize: 11.5, color: theme.textTertiary }}>Edited {new Date(easel.updatedAt).toLocaleDateString()}</Text>
        </View>
        <IconButton icon="ellipsis" box={24} size={12} tooltip="Easel actions" onPress={() => void easelMenu(easel.id, windowId)} />
      </View>
    </View>
  );
}

function EaselImage({ path }: { path: string }) {
  const [broken, setBroken] = useState(false);
  if (broken || !fileExists(path)) return <Text style={{ fontSize: 9, color: "#777777" }}>Image unavailable</Text>;
  return <Image source={{ uri: fileUri(path) }} resizeMode="contain" onError={() => setBroken(true)} style={{ width: "100%", height: "100%" }} />;
}

function SpacesSection({ windowId, query }: { windowId: string; query: string }) {
  const theme = useTheme();
  const colors = useFormColors();
  const { spaces, spaceOrder, tabs, tabLists, windows } = useBrowser(
    useShallow((s) => ({ spaces: s.spaces, spaceOrder: s.spaceOrder, tabs: s.tabs, tabLists: s.tabLists, windows: s.windows })),
  );
  const shown = spaceOrder
    .map((id) => spaces[id])
    .filter((space) => space && !isIncognitoSpace(space.id) && !isIncognitoSpace(space.profileId ?? ""))
    .map((space) => ({
      space: space!,
      tabs: spaceTabIds({ spaces, tabs, tabLists }, space!.id)
        .map((id) => tabs[id]!)
        .filter((tab) => !windows[tab.windowId]?.incognito),
    }))
    .map((entry) => ({ ...entry, shownTabs: entry.tabs.filter((tab) => matchesQuery(query, tabTitle(tab), tab.url, entry.space.name)) }))
    .filter((entry) => matchesQuery(query, entry.space.name) || entry.shownTabs.length);
  if (!shown.length) return <EmptyState title="No matching spaces or tabs" subtitle="Try a space name, tab title, or website." />;
  return (
    <ScrollView contentContainerStyle={{ padding: 24, gap: 20, paddingBottom: 40 }}>
      {shown.map(({ space, tabs, shownTabs }) => (
        <View
          key={space.id}
          style={{
            backgroundColor: colors.group,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.groupBorder,
            borderRadius: 10,
            overflow: "hidden",
          }}
        >
          <View style={{ padding: 14, flexDirection: "row", alignItems: "center", gap: 10 }}>
            <SpaceGlyph spaceId={space.id} size={20} />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: "600", color: theme.textPrimary }}>
                {space.name}
              </Text>
              <Text style={{ fontSize: 11.5, color: theme.textTertiary }}>
                {tabs.length} {tabs.length === 1 ? "tab" : "tabs"}
              </Text>
            </View>
            <Button title="Open Space" onPress={() => useBrowser.getState().switchSpace(windowId, space.id)} />
          </View>
          {shownTabs.map((tab) => (
            <ContextMenuArea key={tab.id} onContextMenu={() => void libraryTabMenu(windowId, tab)}>
              <LibraryRow
                title={tabTitle(tab)}
                detail={hostLabel(tab.url)}
                icon={<Favicon url={tab.url} favicon={tab.favicon} spaceId={tab.spaceId} />}
                onPress={() => {
                  const s = useBrowser.getState();
                  s.switchSpace(windowId, space.id);
                  useBrowser.getState().activate(tab.id, windowId);
                }}
                accessory={<IconButton icon="ellipsis" box={24} size={12} tooltip="Tab actions" onPress={() => void libraryTabMenu(windowId, tab)} />}
              />
            </ContextMenuArea>
          ))}
          {!tabs.length ? <Text style={{ padding: 14, paddingTop: 0, fontSize: 12, color: theme.textTertiary }}>No tabs in this space</Text> : null}
        </View>
      ))}
    </ScrollView>
  );
}

async function libraryTabMenu(windowId: string, tab: Tab) {
  if (!libraryWindow(windowId)) return;
  const s = useBrowser.getState();
  const spaces = s.spaceOrder.map((id) => s.spaces[id]).filter((space) => space && !isIncognitoSpace(space.id) && !isIncognitoSpace(space.profileId ?? ""));
  const choice = await showMenu([
    { id: "open", title: "Open Tab" },
    {
      id: "move",
      title: "Move to Space",
      children: spaces.map((space) => ({
        id: `space:${space!.id}`,
        title: space!.name,
        checked: space!.id === tab.spaceId,
        enabled: space!.id !== tab.spaceId,
      })),
    },
    { separator: true },
    { id: "close", title: "Close Tab" },
  ]);
  if (!choice || !libraryWindow(windowId)) return;
  const current = useBrowser.getState();
  const live = current.tabs[tab.id];
  if (!live || isIncognitoSpace(live.spaceId)) return;
  if (choice === "open") {
    current.switchSpace(windowId, live.spaceId);
    useBrowser.getState().activate(tab.id, windowId);
  }
  if (choice.startsWith("space:")) current.moveTabToSpace(tab.id, choice.slice(6));
  if (choice === "close") current.closeTab(tab.id);
}

type ArchiveEntry = { id: string; title: string; detail: string; at: number; icon: string; cleaned: boolean; tab?: TabSnapshot };

function ArchiveSection({ windowId, query }: { windowId: string; query: string }) {
  const { cleanedTabs, closedTabs, closedGroups, closedWindows, spaces, windows } = useBrowser(
    useShallow((s) => ({
      cleanedTabs: s.cleanedTabs,
      closedTabs: s.closedTabs,
      closedGroups: s.closedGroups,
      closedWindows: s.closedWindows,
      spaces: s.spaces,
      windows: s.windows,
    })),
  );
  const publicTab = (tab: TabSnapshot) => !isIncognitoSpace(tab.spaceId) && !isIncognitoSpace(spaces[tab.spaceId]?.profileId ?? "");
  const spaceName = (id: string) => spaces[id]?.name ?? "Deleted Space";
  const entries: ArchiveEntry[] = [
    ...[...cleanedTabs.map((entry) => ({ entry, cleaned: true })), ...closedTabs.map((entry) => ({ entry, cleaned: false }))]
      .filter(({ entry }) => publicTab(entry.tab) && !windows[entry.windowId]?.incognito)
      .map(({ entry, cleaned }) => ({
        id: entry.id,
        title: entry.tab.customTitle || entry.tab.title || hostLabel(entry.tab.url) || "New Tab",
        detail: `${spaceName(entry.tab.spaceId)} · ${cleaned ? "Cleaned up" : "Closed"} · ${hostLabel(entry.tab.url)}`,
        at: entry.closedAt,
        icon: "archivebox",
        cleaned,
        tab: entry.tab,
      })),
    ...closedGroups
      .filter((entry) => entry.tabs.length && entry.tabs.every(publicTab) && !windows[entry.windowId]?.incognito)
      .map((entry) => ({
        id: entry.id,
        title: entry.group.name || "Tab Group",
        detail: `${spaceName(entry.tabs[0]!.spaceId)} · ${entry.tabs.length} tabs · ${entry.tabs.map((t) => t.customTitle || t.title || hostLabel(t.url)).join(", ")}`,
        at: entry.closedAt,
        icon: "rectangle.stack",
        cleaned: false,
      })),
    ...closedWindows
      .filter((entry) => !isIncognitoSpace(entry.window.spaceId) && entry.tabs.every(publicTab))
      .map((entry) => ({
        id: entry.id,
        title: "Closed Window",
        detail: `${spaceName(entry.window.spaceId)} · ${entry.tabs.length} tabs · ${entry.tabs.map((t) => t.customTitle || t.title || hostLabel(t.url)).join(", ")}`,
        at: entry.closedAt,
        icon: "macwindow",
        cleaned: false,
      })),
  ];
  const shown = entries.filter((entry) => matchesQuery(query, entry.title, entry.detail)).sort((a, b) => b.at - a.at);
  const restore = (entry: ArchiveEntry) => {
    const s = useBrowser.getState();
    if (entry.cleaned) s.restoreCleaned(entry.id, windowId);
    else s.restoreClosed(entry.id, windowId);
  };
  if (!shown.length)
    return (
      <EmptyState
        title={query ? "No matching archived tabs" : "No archived tabs"}
        subtitle={query ? "Try a tab title, website, or space name." : "Closed tabs and tabs cleaned up from your spaces appear here."}
      />
    );
  return (
    <LegendList
      style={{ flex: 1 }}
      data={shown}
      keyExtractor={(entry) => `${entry.cleaned ? "cleaned" : "closed"}:${entry.id}`}
      contentContainerStyle={{ padding: 24, paddingBottom: 40 }}
      renderItem={({ item }) => (
        <LibraryRow
          title={item.title}
          detail={`${new Date(item.at).toLocaleString()} · ${item.detail}`}
          icon={item.tab ? <Favicon url={item.tab.url} favicon={item.tab.favicon} spaceId={item.tab.spaceId} /> : <ArchiveIcon name={item.icon} />}
          onPress={() => restore(item)}
          accessory={<Button title="Restore" onPress={() => restore(item)} />}
        />
      )}
    />
  );
}

function ArchiveIcon({ name }: { name: string }) {
  const theme = useTheme();
  return <Symbol name={name} size={15} color={theme.textSecondary} style={{ width: 18, height: 18 }} />;
}

function LibraryRow({
  title,
  detail,
  icon,
  onPress,
  accessory,
}: {
  title: string;
  detail: string;
  icon: ReactNode;
  onPress: () => void;
  accessory?: ReactNode;
}) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View
      {...hoverProps}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 12,
        borderRadius: 7,
        backgroundColor: hovered ? theme.rowHover : undefined,
      }}
    >
      <Pressable onPress={onPress} style={{ flex: 1, flexDirection: "row", gap: 10, alignItems: "center", paddingVertical: 11 }}>
        {icon}
        <View style={{ flex: 1, gap: 4 }}>
          <Text numberOfLines={1} style={{ color: theme.textPrimary, fontSize: 13 }}>
            {title}
          </Text>
          <Text numberOfLines={2} style={{ color: theme.textTertiary, fontSize: 11.5 }}>
            {detail}
          </Text>
        </View>
      </Pressable>
      {accessory}
    </View>
  );
}
