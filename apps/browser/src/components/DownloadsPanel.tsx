import { cancelDownload, engineCall, pauseDownload, resumeDownload, type Download } from "@bay/nncore";
import { ContextMenuArea, copyText, downloadsFolder, fileExists, MouseArea, openFile, revealFile, Symbol } from "@bay/shell";
import { memo, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useShallow } from "zustand/react/shallow";
import { isEscapeKey } from "../lib/escapeKey";
import { useTheme } from "../lib/theme";
import { webviews } from "../lib/webviews";
import { useBrowser, type BrowserState } from "../store/browser";
import { useWindowId, useWindowUi } from "../store/hooks";
import { activeTabId, engineProfile } from "../store/model";
import { downloadsIn } from "../store/ui";
import { downloadStatus, FileIcon, isOpenWhenDone, toggleOpenWhenDone, trashDownload } from "./Downloads";
import { Keycaps } from "./omnibox/Keycaps";
import { PaletteActionMenu, type PaletteMenuAction } from "./omnibox/PaletteActionMenu";
import { FooterButton, useMenuPresence } from "./omnibox/PaletteContent";
import { PaletteSurface } from "./omnibox/PaletteSurface";
import { usePointerHover, type PointerHoverEvent } from "./omnibox/usePointerHover";
import { hostLabel, matchesQuery } from "./pages/PageLayout";
import { IconButton, useHover } from "./primitives";
import { DOWNLOADS_LIST_TOP, DOWNLOADS_ROW_HEIGHT, PALETTE_FIELD_HEIGHT, PALETTE_FOOTER_HEIGHT } from "./omnibox/constants";

// The downloads, as a palette: search, a file-type filter, ↩ for the selected file and ⌘K for the rest.

// MARK: Filters

type Filter = "all" | "images" | "documents" | "archives" | "videos" | "audio";

const FILTERS: { id: Filter; title: string; icon: string }[] = [
  { id: "all", title: "All Files", icon: "arrow.down.circle" },
  { id: "images", title: "Images", icon: "photo" },
  { id: "documents", title: "Documents", icon: "doc.text" },
  { id: "archives", title: "Archives", icon: "doc.zipper" },
  { id: "videos", title: "Videos", icon: "film" },
  { id: "audio", title: "Audio", icon: "waveform" },
];

const EXTENSIONS: Record<Exclude<Filter, "all">, string[]> = {
  images: ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "avif", "svg", "bmp", "tif", "tiff", "ico", "raw"],
  documents: [
    "pdf",
    "doc",
    "docx",
    "pages",
    "txt",
    "rtf",
    "md",
    "csv",
    "xls",
    "xlsx",
    "numbers",
    "ppt",
    "pptx",
    "key",
    "odt",
    "ods",
    "odp",
    "epub",
    "json",
    "html",
  ],
  archives: ["zip", "dmg", "pkg", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "iso"],
  videos: ["mp4", "mov", "m4v", "webm", "mkv", "avi"],
  audio: ["mp3", "m4a", "wav", "aac", "flac", "ogg", "aiff", "opus"],
};

function kindOf(d: Download): Exclude<Filter, "all"> | null {
  const mime = d.mimeType.toLowerCase();
  if (mime.startsWith("image/")) return "images";
  if (mime.startsWith("video/")) return "videos";
  if (mime.startsWith("audio/")) return "audio";
  const name = d.filename || d.path;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  for (const kind of Object.keys(EXTENSIONS) as (keyof typeof EXTENSIONS)[]) if (EXTENSIONS[kind].includes(ext)) return kind;
  return null;
}

const shownIn = (s: BrowserState, windowId: string, query: string, filter: Filter) =>
  downloadsIn(s, windowId).filter((d) => (filter === "all" || kindOf(d) === filter) && matchesQuery(query, d.filename, d.url));

// MARK: Actions

/** The folder downloads land in: ~/Downloads, or, on a build without it, the newest download's. */
function downloadsFolderFor(windowId: string): string | null {
  const folder = downloadsFolder();
  if (folder) return folder;
  const latest = downloadsIn(useBrowser.getState(), windowId).find((d) => d.state === "finished" && d.path);
  return latest ? latest.path.slice(0, latest.path.lastIndexOf("/")) : null;
}

async function openDownloadsFolder(windowId: string) {
  const folder = downloadsFolderFor(windowId);
  if (!folder || !(await openFile(folder))) throw new Error("Couldn't find the Downloads folder.");
}

const ASK_PREF = "download.prompt_for_download";
const enginePrefsProfile = (windowId: string) => engineProfile(useBrowser.getState().windows[windowId]?.spaceId ?? "");

type Primary = "open" | "pause" | "resume" | "remove" | "folder";

function primaryOf(d: Download | undefined): Primary {
  if (!d) return "folder";
  if (d.state === "downloading") return d.paused ? "resume" : "pause";
  return d.state === "finished" && fileExists(d.path) ? "open" : "remove";
}

const PRIMARY_TITLES: Record<Primary, string> = { open: "Open", pause: "Pause", resume: "Resume", remove: "Remove from List", folder: "Open Downloads Folder" };

function runPrimary(primary: Primary, d: Download | undefined, windowId: string) {
  if (primary === "folder" || !d) return openDownloadsFolder(windowId);
  if (primary === "open") return openFile(d.path);
  if (primary === "pause") return pauseDownload(d.id);
  if (primary === "resume") return resumeDownload(d.id);
  useBrowser.getState().removeDownload(d.id);
}

// MARK: Panel

export function DownloadsPanel({ windowWidth, windowHeight }: { windowWidth: number; windowHeight: number }) {
  const windowId = useWindowId();
  const open = useWindowUi().downloadsOpen;
  if (!open || windowWidth < 1 || windowHeight < 1) return null;
  return <Panel windowId={windowId} windowWidth={windowWidth} windowHeight={windowHeight} />;
}

type Menu = { kind: "actions" | "filter"; title: string; actions: PaletteMenuAction[] };

function Panel({ windowId, windowWidth, windowHeight }: { windowId: string; windowWidth: number; windowHeight: number }) {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState(0);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [askWhere, setAskWhere] = useState<boolean | null>(null);
  const input = useRef<TextInput>(null);
  const scroll = useRef<ScrollView>(null);
  const viewport = useRef({ height: 0, y: 0 });
  const presence = useMenuPresence(menu);
  // Ids only: each row follows its own download, so a progress report re-renders that row, not the panel.
  const ids = useBrowser(useShallow((s) => shownIn(s, windowId, query, filter).map((d) => d.id)));
  const any = useBrowser((s) => downloadsIn(s, windowId).length > 0);
  const selectedIndex = Math.max(0, Math.min(selected, ids.length - 1));
  const selectedId = ids[selectedIndex];
  const primary = useBrowser((s) => primaryOf(selectedId ? s.downloads.find((d) => d.id === selectedId) : undefined));
  const hover = usePointerHover(ids);

  const width = Math.min(760, windowWidth - 32);
  const height = Math.max(240, Math.min(560, windowHeight - 56));
  const appear = useSharedValue(0);
  useEffect(() => {
    appear.set(withTiming(1, { duration: 150, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System }));
  }, [appear]);
  const appearStyle = useAnimatedStyle(() => {
    "worklet";
    const p = appear.get();
    return { opacity: p, transform: [{ translateY: (1 - p) * 6 }] };
  });

  useEffect(() => {
    let live = true;
    engineCall<{ value: boolean }>("nn_prefs_get", enginePrefsProfile(windowId), { name: ASK_PREF })
      .then((r) => live && setAskWhere(r.value))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [windowId]);

  useEffect(() => {
    const visible = viewport.current;
    if (!visible.height) return;
    const top = DOWNLOADS_LIST_TOP + selectedIndex * DOWNLOADS_ROW_HEIGHT;
    const y =
      top < visible.y
        ? top
        : top + DOWNLOADS_ROW_HEIGHT > visible.y + visible.height
          ? top + DOWNLOADS_ROW_HEIGHT - visible.height + DOWNLOADS_LIST_TOP
          : visible.y;
    if (y !== visible.y) {
      visible.y = y;
      scroll.current?.scrollTo({ y, animated: false });
    }
  }, [selectedIndex, ids]);

  const dismiss = () => {
    useBrowser.getState().setDownloadsOpen(windowId, false);
    const active = activeTabId(useBrowser.getState(), windowId);
    if (active) void webviews.get(active)?.focus();
  };
  const closeMenu = () => {
    setMenu(null);
    input.current?.focus();
  };
  const current = () => (selectedId ? useBrowser.getState().downloads.find((d) => d.id === selectedId) : undefined);
  const submit = () => void runPrimary(primary, current(), windowId);

  const openFilterMenu = () =>
    setMenu({
      kind: "filter",
      title: "Show",
      actions: FILTERS.map((f) => ({
        id: f.id,
        title: f.title,
        icon: f.icon,
        checked: f.id === filter,
        run: () => {
          setFilter(f.id);
          setSelected(0);
        },
      })),
    });

  const openActionsMenu = (d = current()) => {
    const actions = d ? downloadActions(d) : [];
    const clearable = downloadsIn(useBrowser.getState(), windowId).some((x) => x.state !== "downloading");
    actions.push(
      { id: "folder", title: "Open Downloads Folder", icon: "folder", hint: d ? undefined : "↩", separator: !!d, run: () => openDownloadsFolder(windowId) },
      ...(askWhere === null
        ? []
        : [
            {
              id: "ask",
              title: "Ask Where to Save Each File",
              icon: "folder.badge.questionmark",
              checked: askWhere,
              run: async () => {
                await engineCall("nn_prefs_set", enginePrefsProfile(windowId), { name: ASK_PREF, value: !askWhere });
                setAskWhere(!askWhere);
              },
            },
          ]),
      ...(clearable ? [{ id: "clear", title: "Clear Downloads", icon: "clear", run: () => useBrowser.getState().clearDownloads(windowId) }] : []),
    );
    setMenu({ kind: "actions", title: d?.filename || "Downloads", actions });
  };

  const move = (delta: 1 | -1) => ids.length && setSelected((i) => (Math.min(i, ids.length - 1) + delta + ids.length) % ids.length);

  const onKeyDown = (e: { nativeEvent: { key: string; metaKey?: boolean; shiftKey?: boolean; ctrlKey?: boolean } }) => {
    const { key, metaKey, shiftKey, ctrlKey } = e.nativeEvent;
    if (key === "Escape") {
      if (menu) return closeMenu();
      if (query) return setQuery("");
      return dismiss();
    }
    if (metaKey && key.toLowerCase() === "k") return openActionsMenu();
    if (metaKey && key.toLowerCase() === "p") return openFilterMenu();
    if (key === "ArrowDown" || (ctrlKey && key === "n") || (key === "Tab" && !shiftKey)) return move(1);
    if (key === "ArrowUp" || (ctrlKey && key === "p") || (key === "Tab" && shiftKey)) return move(-1);
    const d = current();
    if (key === "Enter") {
      if (!metaKey) return submit();
      if (d?.state === "finished") void revealFile(d.path);
      else void openDownloadsFolder(windowId).catch(() => undefined);
      return;
    }
    if (metaKey && shiftKey && key.toLowerCase() === "c" && d) return copyText(d.url);
    if (shiftKey && key === "Backspace" && !query && d && d.state !== "downloading") return useBrowser.getState().removeDownload(d.id);
  };

  const filterInfo = FILTERS.find((f) => f.id === filter)!;
  const empty = ids.length === 0;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none" accessibilityViewIsModal>
      <Pressable
        accessibilityLabel="Close downloads"
        onPress={dismiss}
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.dark ? "#00000012" : "#00000006" }]}
      />
      <Animated.View
        style={[{ position: "absolute", width, height, left: (windowWidth - width) / 2, top: Math.max(16, (windowHeight - height) / 2) }, appearStyle]}
      >
        <PaletteSurface style={{ flex: 1 }}>
          <View style={{ height: PALETTE_FIELD_HEIGHT, flexDirection: "row", alignItems: "center", paddingLeft: 10, paddingRight: 10, gap: 6 }}>
            <IconButton
              icon="chevron.left"
              size={14}
              weight="semibold"
              box={30}
              radius={8}
              color={theme.textSecondary}
              tooltip="Close (Esc)"
              onPress={dismiss}
            />
            <TextInput
              ref={input}
              autoFocus
              value={query}
              onChangeText={(text) => {
                setQuery(text);
                setSelected(0);
              }}
              placeholder="Search downloads…"
              placeholderTextColor={theme.placeholder}
              selectionColor={theme.selection}
              enableFocusRing={false}
              submitBehavior="submit"
              onSubmitEditing={submit}
              keyDownEvents={query ? FIELD_KEYS : EMPTY_FIELD_KEYS}
              onKeyDown={onKeyDown}
              onKeyPress={(e) => isEscapeKey(e) && onKeyDown({ nativeEvent: { key: "Escape" } })}
              style={{ flex: 1, fontSize: 20, color: theme.textPrimary, paddingVertical: 0 }}
            />
            <FilterButton icon={filterInfo.icon} title={filterInfo.title} onPress={openFilterMenu} />
          </View>

          {empty ? (
            <EmptyState filtered={any} onOpenFolder={() => void openDownloadsFolder(windowId).catch(() => undefined)} />
          ) : (
            <ScrollView
              ref={scroll}
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingHorizontal: 7, paddingTop: DOWNLOADS_LIST_TOP, paddingBottom: 6 }}
              keyboardShouldPersistTaps="always"
              onLayout={(e) => {
                viewport.current.height = e.nativeEvent.layout.height;
              }}
              onScroll={(e) => {
                viewport.current.y = e.nativeEvent.contentOffset.y;
              }}
              scrollEventThrottle={16}
            >
              {ids.map((id, index) => (
                <PanelRow
                  key={id}
                  id={id}
                  selected={index === selectedIndex}
                  onHover={(e) => hover(e, () => setSelected(index))}
                  // A click opens a finished file; the rest of ↩'s actions (pause, remove) stay on the keyboard.
                  onPress={(d) => {
                    setSelected(index);
                    if (primaryOf(d) === "open") void openFile(d.path);
                  }}
                  onMenu={(d) => {
                    setSelected(index);
                    openActionsMenu(d);
                  }}
                />
              ))}
            </ScrollView>
          )}

          <View style={{ height: PALETTE_FOOTER_HEIGHT, paddingHorizontal: 7, paddingBottom: 7, flexDirection: "row", alignItems: "center" }}>
            <View
              style={{
                height: 30,
                borderRadius: 16,
                paddingLeft: 9,
                paddingRight: 12,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                backgroundColor: theme.dark ? "#FFFFFF0C" : "#00000006",
                borderWidth: 0.5,
                borderColor: theme.dark ? "#FFFFFF16" : "#00000010",
              }}
            >
              <Symbol name="arrow.down.circle" size={13} color={theme.textSecondary} style={{ width: 16, height: 16 }} />
              <Text style={{ fontSize: 12, color: theme.textPrimary }}>Downloads</Text>
            </View>
            <View style={{ flex: 1 }} />
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 2,
                borderRadius: 18,
                padding: 2,
                backgroundColor: theme.dark ? "#FFFFFF09" : "#00000006",
                borderWidth: 0.5,
                borderColor: theme.dark ? "#FFFFFF13" : "#0000000C",
              }}
            >
              <FooterButton label={PRIMARY_TITLES[primary]} hint="↩" onPress={submit} />
              <FooterButton label="Actions" hint="⌘K" onPress={() => openActionsMenu()} />
            </View>
          </View>

          {presence.shown ? (
            <>
              {menu ? <Pressable accessibilityLabel="Close menu" onPress={closeMenu} style={[StyleSheet.absoluteFill, { borderRadius: 22 }]} /> : null}
              <PaletteActionMenu
                key={`${presence.shown.kind}:${presence.shown.title}`}
                title={presence.shown.title}
                actions={presence.shown.actions}
                side="right"
                top={presence.shown.kind === "filter" ? PALETTE_FIELD_HEIGHT - 8 : undefined}
                placeholder={presence.shown.kind === "filter" ? "Search filters…" : undefined}
                width={Math.min(presence.shown.kind === "filter" ? 280 : 320, width - 16)}
                maxHeight={height - 16 - (presence.shown.kind === "filter" ? PALETTE_FIELD_HEIGHT : 0)}
                onClose={closeMenu}
                progress={presence.progress}
                closing={presence.closing}
              />
            </>
          ) : null}
        </PaletteSurface>
      </Animated.View>
    </View>
  );
}

const FIELD_KEYS = [
  { key: "Escape" },
  { key: "Enter" },
  { key: "ArrowUp" },
  { key: "ArrowDown" },
  { key: "Tab" },
  { key: "Tab", shiftKey: true },
  { key: "n", ctrlKey: true },
  { key: "p", ctrlKey: true },
  { key: "k", metaKey: true },
  { key: "K", metaKey: true },
  { key: "p", metaKey: true },
  { key: "P", metaKey: true },
  { key: "Enter", metaKey: true },
  { key: "c", metaKey: true, shiftKey: true },
  { key: "C", metaKey: true, shiftKey: true },
];
// ⇧⌫ removes the selected download only while the search field is empty, so it still deletes text.
const EMPTY_FIELD_KEYS = [...FIELD_KEYS, { key: "Backspace", shiftKey: true }];

function downloadActions(d: Download): PaletteMenuAction[] {
  const exists = d.state === "finished" && fileExists(d.path);
  const copy = { id: "copy", title: "Copy Download Link", icon: "link", hint: "⇧⌘C", run: () => copyText(d.url) };
  if (d.state === "downloading") {
    return [
      d.paused
        ? { id: "resume", title: "Resume", icon: "play", hint: "↩", run: () => resumeDownload(d.id) }
        : { id: "pause", title: "Pause", icon: "pause", hint: "↩", run: () => pauseDownload(d.id) },
      { id: "whenDone", title: "Open When Done", icon: "arrow.up.forward.app", checked: isOpenWhenDone(d.id), run: () => toggleOpenWhenDone(d.id) },
      { id: "cancel", title: "Cancel Download", icon: "xmark.circle", run: () => cancelDownload(d.id) },
      copy,
    ];
  }
  return [
    ...(exists
      ? [
          { id: "open", title: "Open", icon: "arrow.up.forward.app", hint: "↩", run: () => openFile(d.path) },
          { id: "reveal", title: "Show in Finder", icon: "finder", hint: "⌘↩", run: () => revealFile(d.path) },
        ]
      : []),
    copy,
    ...(exists ? [{ id: "trash", title: "Move to Trash", icon: "trash", separator: true, run: () => trashDownload(d) }] : []),
    {
      id: "remove",
      title: "Remove from List",
      icon: "minus.circle",
      hint: exists ? "⇧⌫" : "↩",
      separator: !exists,
      run: () => useBrowser.getState().removeDownload(d.id),
    },
  ];
}

// MARK: Pieces

function FilterButton({ icon, title, onPress }: { icon: string; title: string; onPress(): void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps} tooltip="Filter (⌘P)">
      <Pressable accessibilityRole="button" accessibilityLabel={`Show ${title}`} onPress={onPress}>
        <View
          style={{
            height: 30,
            borderRadius: 8,
            paddingHorizontal: 8,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            backgroundColor: hovered ? theme.rowHover : undefined,
          }}
        >
          <Symbol name={icon} size={14} color={theme.textSecondary} style={{ width: 17, height: 17 }} />
          <Text style={{ fontSize: 14, color: theme.textSecondary }}>{title}</Text>
          <Symbol name="chevron.down" size={9} weight="semibold" color={theme.textTertiary} style={{ width: 12, height: 12 }} />
        </View>
      </Pressable>
    </View>
  );
}

function EmptyState({ filtered, onOpenFolder }: { filtered: boolean; onOpenFolder(): void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  // The button inverts the theme: light on dark, dark on light.
  const [buttonFill, buttonHover] = theme.dark ? ["#EDEDF0", "#FFFFFF"] : ["#1C1C1E", "#000000"];
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24, paddingBottom: 12 }}>
      {filtered ? (
        <>
          <Symbol name="magnifyingglass" size={26} color={theme.textTertiary} style={{ width: 36, height: 36 }} />
          <Text style={{ marginTop: 12, fontSize: 15, fontWeight: "600", color: theme.textPrimary }}>No matching downloads</Text>
          <Text style={{ marginTop: 4, fontSize: 13, color: theme.textSecondary }}>Try another name, or show all files.</Text>
        </>
      ) : (
        <>
          <View style={{ width: 56, height: 56, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "#5EC2CB" }}>
            <Symbol name="arrow.down.circle" size={30} weight="medium" color="#FFFFFF" style={{ width: 36, height: 36 }} />
          </View>
          <Text style={{ marginTop: 18, fontSize: 17, fontWeight: "600", color: theme.textPrimary }}>Nothing downloaded yet</Text>
          <Text style={{ marginTop: 6, fontSize: 13, lineHeight: 17, textAlign: "center", color: theme.textSecondary, maxWidth: 320 }}>
            Files you download land in Downloads and are listed here, one Return from the Finder.
          </Text>
          <View {...hoverProps} style={{ marginTop: 18 }}>
            <Pressable accessibilityRole="button" accessibilityLabel="Open Downloads Folder" onPress={onOpenFolder}>
              <View
                style={{
                  height: 30,
                  borderRadius: 8,
                  paddingLeft: 11,
                  paddingRight: 4,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  backgroundColor: hovered ? buttonHover : buttonFill,
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: "500", color: theme.dark ? "#1C1C1E" : "#FFFFFF" }}>Open Downloads Folder</Text>
                <View
                  style={{
                    height: 22,
                    minWidth: 22,
                    borderRadius: 5,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: theme.dark ? "#0000001A" : "#FFFFFF26",
                  }}
                >
                  <Text style={{ fontSize: 12, color: theme.dark ? "#1C1C1E99" : "#FFFFFFB3" }}>↩</Text>
                </View>
              </View>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

const PanelRow = memo(function PanelRow({
  id,
  selected,
  onHover,
  onPress,
  onMenu,
}: {
  id: string;
  selected: boolean;
  onHover(e: PointerHoverEvent): void;
  onPress(d: Download): void;
  onMenu(d: Download): void;
}) {
  const theme = useTheme();
  const d = useBrowser((s) => s.downloads.find((x) => x.id === id));
  if (!d) return null;
  const exists = d.state !== "finished" || fileExists(d.path);
  const done = d.state === "finished" && exists;
  const progress = d.total > 0 ? d.received / d.total : 0;
  const host = hostLabel(d.url);
  return (
    <View onMouseEnter={onHover}>
      <MouseArea path={done ? d.path : null}>
        <ContextMenuArea onContextMenu={() => onMenu(d)}>
          <Pressable accessibilityRole="button" accessibilityLabel={d.filename || "Download"} accessibilityState={{ selected }} onPress={() => onPress(d)}>
            <View
              style={{
                height: DOWNLOADS_ROW_HEIGHT,
                flexDirection: "row",
                alignItems: "center",
                gap: 11,
                borderRadius: 9,
                paddingHorizontal: 10,
                backgroundColor: selected ? (theme.dark ? "#FFFFFF10" : "#0000000B") : undefined,
              }}
            >
              <View style={{ opacity: exists ? 1 : 0.45 }}>
                <FileIcon path={d.path || d.filename} size={26} />
              </View>
              <Text
                numberOfLines={1}
                style={{
                  flexShrink: 1,
                  maxWidth: "50%",
                  fontSize: 13,
                  color: exists ? theme.textPrimary : theme.textSecondary,
                  textDecorationLine: exists ? "none" : "line-through",
                }}
              >
                {d.filename || "Preparing…"}
              </Text>
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, color: theme.textSecondary }}>
                {d.state === "downloading" ? downloadStatus(d) : host}
              </Text>
              {d.state === "downloading" ? (
                <View style={{ width: 72, height: 4, borderRadius: 2, backgroundColor: theme.dark ? "#FFFFFF1F" : "#0000001A" }}>
                  <View
                    style={{
                      width: `${Math.max(progress, 0.03) * 100}%`,
                      height: 4,
                      borderRadius: 2,
                      backgroundColor: d.paused ? theme.textTertiary : theme.accent,
                    }}
                  />
                </View>
              ) : (
                <Text numberOfLines={1} style={{ fontSize: 12, color: theme.textTertiary }}>
                  {downloadStatus(d, exists)}
                </Text>
              )}
              {selected ? <Keycaps hint="↩" /> : null}
            </View>
          </Pressable>
        </ContextMenuArea>
      </MouseArea>
    </View>
  );
});
