import { View, isMac } from "@bay/platform";
import { cancelDownload, pauseDownload, resumeDownload, type Download } from "@bay/nncore";
import { copyFile, copyText, fileExists, fileIcon, moveToTrash, openFile, revealFile, showMenu, Symbol, type MenuItem } from "@bay/shell";
import { memo, useEffect, useRef, useState } from "react";
import { Image, StyleSheet } from "react-native";
import Animated, { Easing, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "@bay/platform/motion";
import { useTheme } from "../lib/theme";
import { layout } from "../lib/constants";
import { useBrowser } from "../store/browser";
import { useSidebarOpen, useWindowId } from "../store/hooks";
import { downloadVisibleIn } from "../store/ui";
import { useSidebarOnRight, useTabLayout } from "./layout/windowLayout";
import { SIDEBAR_FOOTER_DOWNLOADS } from "./layout/constants";
import { openInternalPage } from "./pages/urls";
import { useSidebarWidth } from "./sidebar/tokens";
import { showToast } from "./layout/splitActions";

// MARK: Formatting

export function formatBytes(n: number) {
  if (n < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} sec left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
  return `${Math.round(seconds / 3600)} hr left`;
}

export function downloadStatus(d: Download, exists = true) {
  if (d.state === "finished") return exists ? formatBytes(d.total > 0 ? d.total : d.received) : "Deleted";
  if (d.state === "failed") return "Failed to Download";
  if (d.state === "cancelled") return "Cancelled";
  const progress = d.total > 0 ? `${formatBytes(d.received)} of ${formatBytes(d.total)}` : formatBytes(d.received);
  if (d.paused) return `${progress} — Paused`;
  if (d.speed > 0 && d.total > 0) return `${progress}, ${formatBytes(d.speed)}/s — ${formatDuration((d.total - d.received) / d.speed)}`;
  return progress;
}

// MARK: Actions

const openWhenDone = new Set<string>();

const g = globalThis as { __nnDownloadsWatch?: () => void };
g.__nnDownloadsWatch?.();
g.__nnDownloadsWatch = useBrowser.subscribe((s, prev) => {
  if (s.downloads === prev.downloads || !openWhenDone.size) return;
  for (const d of s.downloads) {
    if (d.state !== "downloading" && openWhenDone.delete(d.id) && d.state === "finished") void openFile(d.path);
  }
});

export const isOpenWhenDone = (id: string) => openWhenDone.has(id);

export function toggleOpenWhenDone(id: string) {
  if (openWhenDone.has(id)) openWhenDone.delete(id);
  else openWhenDone.add(id);
}

export async function downloadMenu(d: Download, windowId: string) {
  const exists = d.state === "finished" && fileExists(d.path);
  const items: MenuItem[] =
    d.state === "downloading"
      ? [
          { id: "whenDone", title: "Open When Done", checked: openWhenDone.has(d.id) },
          { id: d.paused ? "resume" : "pause", title: d.paused ? "Resume" : "Pause" },
          { id: "cancel", title: "Cancel" },
        ]
      : [
          { id: "open", title: "Open", enabled: exists },
          { id: "reveal", title: isMac ? "Show in Finder" : "Show in File Explorer", enabled: exists },
          { id: "copyFile", title: "Copy File", enabled: exists },
          { id: "copyPath", title: "Copy Path", enabled: d.state === "finished" && !!d.path },
        ];
  items.push(
    { separator: true },
    { id: "copy", title: "Copy Download Link" },
    { id: "page", title: "Show All Downloads" },
    { separator: true },
    ...(exists ? [{ id: "trash", title: "Move to Trash" }] : []),
    { id: "remove", title: "Remove from List", enabled: d.state !== "downloading" },
  );
  const choice = await showMenu(items);
  if (choice === "whenDone") toggleOpenWhenDone(d.id);
  if (choice === "pause") void pauseDownload(d.id);
  if (choice === "resume") void resumeDownload(d.id);
  if (choice === "cancel") void cancelDownload(d.id);
  if (choice === "open") void openFile(d.path);
  if (choice === "reveal") void revealFile(d.path);
  if (choice === "copyFile") {
    try {
      await copyDownloadFile(d);
    } catch (error) {
      showToast(windowId, "Couldn't copy file", error instanceof Error ? error.message : "Try again.");
    }
  }
  if (choice === "copyPath") copyText(d.path);
  if (choice === "copy") copyText(d.url);
  if (choice === "page") openInternalPage("downloads", windowId);
  if (choice === "trash") void trashDownload(d);
  if (choice === "remove") useBrowser.getState().removeDownload(d.id);
}

export async function copyDownloadFile(d: Download) {
  if (!(await copyFile(d.path))) throw new Error("The file may have been moved or deleted.");
}

export async function trashDownload(d: Download) {
  if (await moveToTrash(d.path)) useBrowser.getState().removeDownload(d.id);
}

const iconCache = new Map<string, string | null>();
// Memoized: its row re-renders with every progress report.
export const FileIcon = memo(function FileIcon({ path, size = 28 }: { path: string; size?: number }) {
  const theme = useTheme();
  const key = `${path}@${size}`;
  const [uri, setUri] = useState(() => iconCache.get(key) ?? null);
  useEffect(() => {
    if (iconCache.has(key)) return setUri(iconCache.get(key) ?? null);
    let live = true;
    void fileIcon(path || "file.bin", size).then((u) => {
      iconCache.set(key, u);
      if (live) setUri(u);
    });
    return () => {
      live = false;
    };
  }, [key]);
  return uri ? (
    <Image source={{ uri }} style={{ width: size, height: size }} />
  ) : (
    <Symbol name="doc" size={size * 0.62} color={theme.icon} style={{ width: size, height: size }} />
  );
});

// MARK: Magnet

export function DownloadMagnet() {
  const windowId = useWindowId();
  const sidebarOpen = useSidebarOpen();
  const sidebarWidth = useSidebarWidth(windowId);
  const topStrip = useTabLayout() === "top";
  const right = useSidebarOnRight();
  const [flight, setFlight] = useState<{ id: string; path: string } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const t = useSharedValue(0);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    seen.current = new Set(useBrowser.getState().downloads.map((d) => d.id));
    return useBrowser.subscribe((s, prev) => {
      if (s.downloads === prev.downloads) return;
      const fresh = s.downloads.find((d) => !seen.current!.has(d.id));
      s.downloads.forEach((d) => seen.current!.add(d.id));
      if (!fresh || s.ui.focusedWindowId !== windowId || !downloadVisibleIn(fresh, s.windows[windowId])) return;
      t.set(0);
      setFlight({ id: fresh.id, path: fresh.path || fresh.filename });
      // A second download within the flight restarts it: only the flight that finished lands.
      const land = () => setFlight(null);
      t.set(
        withTiming(1, { duration: 700, easing: Easing.bezier(0.45, 0, 0.2, 1) }, (finished) => {
          if (finished) runOnJS(land)();
        }),
      );
    });
  }, [windowId]);

  const sidebar = !topStrip && sidebarOpen ? sidebarWidth : 0;
  // The sidebar's left edge: the window's, or the page's right one with the sidebar on the right.
  const sidebarLeft = right ? size.width - sidebar : 0;
  const footer = {
    x: sidebarLeft + layout.sidebarInset + SIDEBAR_FOOTER_DOWNLOADS.size / 2,
    y: size.height - SIDEBAR_FOOTER_DOWNLOADS.bottom - SIDEBAR_FOOTER_DOWNLOADS.size / 2,
  };
  const target = topStrip ? { x: size.width - 25, y: 21 } : sidebarOpen ? footer : { x: 24, y: 24 };
  const start = { x: (right ? 0 : sidebar) + (size.width - sidebar) / 2, y: size.height * 0.45 };
  const icon = 44;
  const steps = [0, 0.25, 0.5, 0.75, 1];
  const xs = steps.map((p) => start.x + (target.x - start.x) * p - icon / 2);
  const ys = steps.map((p) => start.y + (target.y - start.y) * p - Math.sin(Math.PI * p) * 90 - icon / 2);
  const flightStyle = useAnimatedStyle(() => {
    const p = t.get();
    return {
      opacity: interpolate(p, [0, 0.1, 0.8, 1], [0, 1, 1, 0]),
      transform: [
        { translateX: interpolate(p, steps, xs) },
        { translateY: interpolate(p, steps, ys) },
        { scale: interpolate(p, [0, 0.15, 1], [0.6, 1.1, 0.3]) },
      ],
    };
  }, [xs.join(), ys.join()]);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={(e) => setSize(e.nativeEvent.layout)}>
      {flight && (
        <Animated.View style={[{ position: "absolute", left: 0, top: 0, width: icon, height: icon }, flightStyle]}>
          <FileIcon path={flight.path} size={icon} />
        </Animated.View>
      )}
    </View>
  );
}
