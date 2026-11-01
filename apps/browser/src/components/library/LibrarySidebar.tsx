import type { Download } from "@bay/nncore";
import { ContextMenuArea, fileExists, MouseArea, openFile, Symbol, WindowDragRegion } from "@bay/shell";
import { LegendList } from "@legendapp/list/react-native";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { layout } from "../../lib/constants";
import { useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { downloadsIn } from "../../store/ui";
import { downloadMenu, downloadStatus, FileIcon } from "../Downloads";
import { showToast } from "../layout/splitActions";
import { EmptyState, hostLabel, matchesQuery } from "../pages/PageLayout";
import { useAddressBarInSidebar, useSidebarOnRight } from "../layout/windowLayout";
import { IconButton, useHover } from "../primitives";
import { PROFILE_INDICATOR_X } from "../spaces/constants";
import { SearchField, useFormColors } from "../settings/controls";
import { ADDRESS_LIGHTS_Y } from "../sidebar/constants";
import { useSidebarTokens, useSidebarWidth } from "../sidebar/tokens";
import { newEasel, openLibraryPage } from "./actions";
import { importMediaFiles, LibrarySectionBody } from "./LibraryPage";
import { SECTIONS, type Section } from "./sections";
import { closeLibrarySidebar, LIBRARY_RAIL as RAIL, showLibrarySidebar, useLibrarySidebar } from "./sidebarState";
import { startLibrary, useLibrary } from "./state";

// Arc's Library in the sidebar: a rail of its sections down the left, and the chosen one's list beside it, with the
// page still showing. Back goes to the tabs; the other button opens it as a page instead.

export function LibrarySidebar({ windowId }: { windowId: string }) {
  const colors = useFormColors();
  const width = useSidebarWidth(windowId);
  const right = useSidebarOnRight();
  // The window buttons sit at the sidebar's top left: over the rail on the left, over the list on the right (where
  // they show only with the address bar in the sidebar). The field starts after them.
  const addressInSidebar = useAddressBarInSidebar();
  const lightsHere = !right || addressInSidebar;
  const fieldInset = !lightsHere ? 0 : right ? PROFILE_INDICATOR_X - layout.sidebarInset : PROFILE_INDICATOR_X - RAIL;
  const section = useLibrarySidebar((l) => l[windowId]) ?? "media";
  const [query, setQuery] = useState("");
  const [listWidth, setListWidth] = useState(width - RAIL);
  const error = useLibrary((s) => s.error);
  const loaded = useLibrary((s) => s.loaded);
  useEffect(() => startLibrary(), []);
  useEffect(() => setQuery(""), [section]);
  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    // The rail keeps to the window's edge: on the right, everything mirrors.
    <View style={{ width, height: "100%", flexDirection: right ? "row-reverse" : "row" }}>
      {/* The window moves by the band the window buttons sit in; the search field over it still takes clicks. */}
      <WindowDragRegion style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2 * ADDRESS_LIGHTS_Y }} />
      <View style={{ width: RAIL, paddingTop: layout.sidebarHeader, paddingBottom: layout.cardInset + 4, alignItems: "center" }}>
        <View style={{ flex: 1, justifyContent: "center", gap: 18 }}>
          {SECTIONS.map((item) => (
            <RailButton
              key={item.id}
              title={item.title}
              icon={item.icon}
              selected={item.id === section}
              onPress={() => showLibrarySidebar(windowId, item.id)}
            />
          ))}
        </View>
        <View style={{ flexDirection: "row", gap: 2 }}>
          <IconButton icon="arrow.left" size={13} box={28} tooltip="Back to Tabs" onPress={() => closeLibrarySidebar(windowId)} />
          <IconButton icon="arrow.up.left.and.arrow.down.right" size={12} box={28} tooltip="Open as Page" onPress={() => openLibraryPage(windowId, section)} />
        </View>
      </View>
      <View style={{ flex: 1, [right ? "paddingLeft" : "paddingRight"]: layout.sidebarInset, paddingBottom: layout.cardInset }}>
        {/* On the left the window buttons sit over the rail's top and a little past it: the field starts after them. */}
        {/* Centred on the window buttons' line, as the sidebar's own header buttons are. */}
        <View style={{ height: 2 * ADDRESS_LIGHTS_Y, flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: fieldInset }}>
          <SearchField value={query} onChangeText={setQuery} placeholder={`Search ${current.title}…`} style={{ flex: 1, maxWidth: 320 }} />
          <SectionAction windowId={windowId} section={section} disabled={!loaded || !!error} />
        </View>
        {error ? (
          <Text selectable style={{ paddingHorizontal: 4, paddingBottom: 8, fontSize: 12, color: colors.destructive }}>
            {error}
          </Text>
        ) : null}
        <View style={{ flex: 1, marginHorizontal: -4 }} onLayout={(e) => setListWidth(e.nativeEvent.layout.width)}>
          {section === "downloads" ? (
            <SidebarDownloads windowId={windowId} query={query} />
          ) : (
            <LibrarySectionBody windowId={windowId} section={section} query={query} width={listWidth} compact />
          )}
        </View>
      </View>
    </View>
  );
}

function RailButton({ title, icon, selected, onPress }: { title: string; icon: string; selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const { hovered, hoverProps } = useHover();
  const color = selected ? theme.textPrimary : hovered ? theme.textSecondary : theme.textTertiary;
  return (
    <View {...hoverProps}>
      <Pressable
        accessibilityRole="tab"
        accessibilityLabel={title}
        accessibilityState={{ selected }}
        onPress={onPress}
        style={({ pressed }) => ({
          width: RAIL - 10,
          paddingVertical: 8,
          borderRadius: 10,
          alignItems: "center",
          gap: 4,
          opacity: pressed ? 0.7 : 1,
          backgroundColor: selected ? tokens.groupFillEmphasized : hovered ? theme.rowHover : undefined,
        })}
      >
        <Symbol name={icon} size={17} color={color} style={{ width: 24, height: 22 }} />
        <Text numberOfLines={2} style={{ fontSize: 10, fontWeight: "600", textAlign: "center", color }}>
          {title}
        </Text>
      </Pressable>
    </View>
  );
}

function SectionAction({ windowId, section, disabled }: { windowId: string; section: Section; disabled: boolean }) {
  const [importing, setImporting] = useState(false);
  const clearable = useBrowser((s) => downloadsIn(s, windowId).some((d) => d.state !== "downloading"));
  if (section === "media")
    return (
      <IconButton
        icon="plus"
        size={13}
        box={28}
        tooltip="Import Images…"
        disabled={disabled || importing}
        onPress={() => {
          setImporting(true);
          void importMediaFiles(windowId)
            .then((failed) => {
              if (failed) showToast(windowId, "Couldn't Import Images", `${failed === 1 ? "One file" : `${failed} files`} couldn't be imported.`);
            })
            .catch((error) => showToast(windowId, "Couldn't Import Images", String(error)))
            .finally(() => setImporting(false));
        }}
      />
    );
  if (section === "easels") return <IconButton icon="plus" size={13} box={28} tooltip="New Easel" disabled={disabled} onPress={() => newEasel(windowId)} />;
  if (section === "downloads")
    return (
      <IconButton
        icon="xmark.circle"
        size={13}
        box={28}
        tooltip="Clear All"
        disabled={!clearable}
        onPress={() => useBrowser.getState().clearDownloads(windowId)}
      />
    );
  return null;
}

function SidebarDownloads({ windowId, query }: { windowId: string; query: string }) {
  const theme = useTheme();
  const downloads = useBrowser(useShallow((s) => downloadsIn(s, windowId)));
  const shown = downloads.filter((d) => matchesQuery(query, d.filename, d.url));
  if (!shown.length)
    return (
      <EmptyState
        icon={<Symbol name="arrow.down.circle" size={26} color={theme.textTertiary} style={{ width: 34, height: 34 }} />}
        title={query ? "No matching downloads" : "Files you download appear here"}
      />
    );
  return (
    <LegendList
      style={{ flex: 1 }}
      data={shown}
      keyExtractor={(d) => d.id}
      contentContainerStyle={{ paddingVertical: 4, paddingBottom: 16 }}
      renderItem={({ item }) => <DownloadRow d={item} windowId={windowId} />}
    />
  );
}

const IMAGE = /\.(png|jpe?g|gif|webp|heic|heif|avif|svg|bmp|tiff?)$/i;
const VIDEO = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const AUDIO = /\.(mp3|m4a|wav|aac|flac|ogg)$/i;
const ARCHIVE = /\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/i;

/** What a finished download is, in a word: "PDF", "Image", "Video"… else its extension. */
function fileKind(name: string): string {
  if (IMAGE.test(name)) return "Image";
  if (VIDEO.test(name)) return "Video";
  if (AUDIO.test(name)) return "Audio";
  if (ARCHIVE.test(name)) return "Archive";
  if (/\.dmg$/i.test(name)) return "Disk Image";
  const ext = /\.([a-z0-9]{1,6})$/i.exec(name)?.[1];
  return ext ? ext.toUpperCase() : "File";
}

function DownloadRow({ d, windowId }: { d: Download; windowId: string }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const exists = d.state !== "finished" || fileExists(d.path);
  const done = d.state === "finished" && exists;
  const progress = d.total > 0 ? d.received / d.total : 0;
  const host = hostLabel(d.tabUrl || d.referrer || d.url);
  const detail = done ? `${fileKind(d.filename)}${host ? ` from ${host}` : ""}` : downloadStatus(d, exists);
  const open = async () => {
    if (!done) return;
    if (!(await openFile(d.path))) showToast(windowId, "Couldn't Open File", "The file may have been moved or deleted.");
  };
  return (
    <MouseArea path={done ? d.path : null}>
      <ContextMenuArea onContextMenu={() => void downloadMenu(d, windowId)}>
        <View {...hoverProps} style={{ marginHorizontal: 4, borderRadius: 8, backgroundColor: hovered ? theme.rowHover : undefined }}>
          <Pressable
            accessibilityLabel={`Open ${d.filename}`}
            onPress={() => void open()}
            style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8, paddingVertical: 7 }}
          >
            <View style={{ opacity: exists ? 1 : 0.45 }}>
              <FileIcon path={d.path || d.filename} size={28} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                numberOfLines={1}
                style={{
                  fontSize: 13,
                  color: exists ? theme.textPrimary : theme.textSecondary,
                  textDecorationLine: exists ? "none" : "line-through",
                }}
              >
                {d.filename || "Preparing…"}
              </Text>
              <Text numberOfLines={1} style={{ fontSize: 11, color: theme.textTertiary }}>
                {detail}
              </Text>
              {d.state === "downloading" ? (
                <View style={{ height: 3, borderRadius: 1.5, marginTop: 2, backgroundColor: theme.rowHover }}>
                  <View
                    style={{
                      width: `${Math.max(progress, 0.03) * 100}%`,
                      height: 3,
                      borderRadius: 1.5,
                      backgroundColor: d.paused ? theme.textTertiary : theme.accent,
                    }}
                  />
                </View>
              ) : null}
            </View>
          </Pressable>
        </View>
      </ContextMenuArea>
    </MouseArea>
  );
}
