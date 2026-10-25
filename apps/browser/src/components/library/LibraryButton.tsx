import { ContextMenuArea, fileExists, MouseArea, openFile, showMenu, Surface, Symbol } from "@bay/shell";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { hex, useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { isIncognitoSpace } from "../../store/model";
import { downloadsIn } from "../../store/ui";
import { downloadMenu, FileIcon } from "../Downloads";
import { showToast } from "../layout/splitActions";
import { IconButton, useHover } from "../primitives";
import { useSidebarWidth } from "../sidebar/tokens";
import { openLibrary } from "./actions";
import { startLibrary, useLibrary } from "./state";

type RecentTypes = { media: boolean; downloads: boolean };

export function LibraryButton({ windowId }: { windowId: string }) {
  const theme = useTheme();
  const privateWindow = useBrowser((s) => !s.windows[windowId] || s.windows[windowId].incognito || isIncognitoSpace(s.windows[windowId].spaceId));
  const downloads = useBrowser(useShallow((s) => downloadsIn(s, windowId)));
  const downloading = downloads.filter((d) => d.state === "downloading");
  const total = downloading.reduce((n, d) => n + Math.max(0, d.total), 0);
  const received = downloading.reduce((n, d) => n + Math.max(0, d.received), 0);
  const progress = total > 0 ? Math.min(1, received / total) : 0.2;
  const [recentTypes, setRecentTypes] = useState<RecentTypes>({ media: true, downloads: true });
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const width = useSidebarWidth(windowId) - 20;
  const cancelTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    setOpen(false);
  }, [privateWindow, windowId]);

  const keepOpen = () => {
    cancelTimer();
    if (!privateWindow) setOpen(true);
  };
  const enter = () => {
    cancelTimer();
    if (!privateWindow) timer.current = setTimeout(() => setOpen(true), 250);
  };
  const leave = () => {
    cancelTimer();
    timer.current = setTimeout(() => setOpen(false), 280);
  };
  const openPage = (section?: string) => {
    cancelTimer();
    setOpen(false);
    openLibrary(windowId, section);
  };
  async function preferences() {
    cancelTimer();
    setOpen(false);
    const choice = await showMenu([
      { id: "media", title: "Show Recent Media", checked: recentTypes.media },
      { id: "downloads", title: "Show Recent Downloads", checked: recentTypes.downloads },
      { separator: true },
      { id: "library", title: "Open Library" },
    ]);
    if (choice === "media" || choice === "downloads") setRecentTypes((types) => ({ ...types, [choice]: !types[choice] }));
    if (choice === "library") openPage();
  }

  return (
    <View onMouseEnter={enter} onMouseLeave={leave} style={{ width: 28, height: 28, overflow: "visible" }}>
      <ContextMenuArea
        onContextMenu={() => {
          if (privateWindow) openPage();
          else void preferences();
        }}
      >
        <IconButton
          icon="books.vertical"
          size={15}
          box={28}
          radius={7}
          tooltip={downloading.length ? `Library · ${downloading.length} downloading` : "Library"}
          onPress={() => openPage()}
        />
      </ContextMenuArea>
      {downloading.length ? (
        <View pointerEvents="none" style={{ position: "absolute", bottom: 2, left: 5, right: 5, height: 2, borderRadius: 1, backgroundColor: theme.rowHover }}>
          <View
            style={{
              width: `${Math.max(0.08, progress) * 100}%`,
              height: 2,
              borderRadius: 1,
              backgroundColor: downloading.every((d) => d.paused) ? theme.textTertiary : theme.accent,
            }}
          />
        </View>
      ) : null}
      {open && !privateWindow ? (
        <View onMouseEnter={keepOpen} onMouseLeave={leave} style={{ position: "absolute", bottom: 28, left: 0, width, paddingBottom: 8 }}>
          <Surface
            fill={hex(theme.dark ? "#292729" : "#FCFBFC")}
            cornerRadius={12}
            borderColor={hex(theme.panelBorder)}
            borderWidth={0.5}
            shadowColor="#000000"
            shadowOpacity={theme.dark ? 0.4 : 0.16}
            shadowRadius={16}
            shadowOffset={[0, 5]}
          >
            <RecentLibrary
              windowId={windowId}
              types={recentTypes}
              openPage={openPage}
              onOpenFile={() => {
                cancelTimer();
                setOpen(false);
              }}
            />
          </Surface>
        </View>
      ) : null}
    </View>
  );
}

function RecentLibrary({
  windowId,
  types,
  openPage,
  onOpenFile,
}: {
  windowId: string;
  types: RecentTypes;
  openPage: (section?: string) => void;
  onOpenFile: () => void;
}) {
  const theme = useTheme();
  const media = useLibrary((s) => s.media);
  const error = useLibrary((s) => s.error);
  const downloads = useBrowser(useShallow((s) => downloadsIn(s, windowId)));
  const recentMedia = types.media
    ? Object.values(media)
        .filter((m) => !m.source?.profileId || !isIncognitoSpace(m.source.profileId))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 5)
    : [];
  const recentDownloads = types.downloads ? downloads.filter((d) => d.state === "finished").slice(0, 5) : [];
  useEffect(() => startLibrary(), []);

  async function open(path: string) {
    onOpenFile();
    try {
      if (!(await openFile(path))) showToast(windowId, "Couldn't Open File", "The file may have been moved or deleted.");
    } catch (error) {
      showToast(windowId, "Couldn't Open File", String(error));
    }
  }

  return (
    <View style={{ paddingVertical: 8 }}>
      <Pressable
        accessibilityLabel="Open Library"
        onPress={() => openPage()}
        style={{ paddingHorizontal: 13, paddingVertical: 6, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
      >
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.textPrimary }}>Library</Text>
        <Symbol name="chevron.right" size={10} color={theme.textTertiary} style={{ width: 12, height: 14 }} />
      </Pressable>
      <ScrollView style={{ maxHeight: 330 }}>
        {error ? (
          <Text selectable style={{ fontSize: 12, color: theme.textSecondary, padding: 13 }}>
            {error}
          </Text>
        ) : null}
        {recentMedia.length ? <RecentHeading title="Recent Media" onPress={() => openPage("media")} /> : null}
        {recentMedia.map((m) => (
          <RecentFile key={m.id} name={m.name} path={m.path} onPress={() => void open(m.path)} icon={<RecentImage path={m.path} />} />
        ))}
        {recentDownloads.length ? <RecentHeading title="Recent Downloads" onPress={() => openPage("downloads")} /> : null}
        {recentDownloads.map((d) => (
          <ContextMenuArea key={d.id} onContextMenu={() => void downloadMenu(d, windowId)}>
            <RecentFile name={d.filename} path={d.path} onPress={() => void open(d.path)} icon={<FileIcon path={d.path} size={30} />} />
          </ContextMenuArea>
        ))}
        {!recentMedia.length && !recentDownloads.length ? (
          <Text style={{ fontSize: 12, color: theme.textTertiary, paddingHorizontal: 13, paddingVertical: 14 }}>
            {types.media || types.downloads
              ? "No recent files. Saved images and completed downloads appear here."
              : "Recent previews are hidden. Right-click Library to choose what appears here."}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

function RecentHeading({ title, onPress }: { title: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} style={{ paddingHorizontal: 13, paddingTop: 10, paddingBottom: 5 }}>
      <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textTertiary }}>{title}</Text>
    </Pressable>
  );
}

function RecentFile({ name, path, icon, onPress }: { name: string; path: string; icon: ReactNode; onPress: () => void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const exists = fileExists(path);
  return (
    <MouseArea path={exists ? path : null}>
      <View {...hoverProps} style={{ marginHorizontal: 5, borderRadius: 7, backgroundColor: hovered ? theme.rowHover : undefined }}>
        <Pressable
          disabled={!exists}
          onPress={onPress}
          style={{ paddingHorizontal: 8, paddingVertical: 7, flexDirection: "row", alignItems: "center", gap: 9, opacity: exists ? 1 : 0.5 }}
        >
          <View style={{ width: 30, height: 30, alignItems: "center", justifyContent: "center" }}>{icon}</View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text numberOfLines={1} style={{ fontSize: 12, color: theme.textPrimary }}>
              {name}
            </Text>
            {!exists ? <Text style={{ fontSize: 11, color: theme.textTertiary }}>File unavailable</Text> : null}
          </View>
        </Pressable>
      </View>
    </MouseArea>
  );
}

function RecentImage({ path }: { path: string }) {
  const theme = useTheme();
  const [broken, setBroken] = useState(false);
  if (broken || !fileExists(path)) return <Symbol name="photo" size={20} color={theme.textTertiary} style={{ width: 30, height: 30 }} />;
  return (
    <Image
      source={{ uri: `file://${path.split("/").map(encodeURIComponent).join("/")}` }}
      onError={() => setBroken(true)}
      resizeMode="cover"
      style={{ width: 30, height: 30, borderRadius: 4 }}
    />
  );
}
