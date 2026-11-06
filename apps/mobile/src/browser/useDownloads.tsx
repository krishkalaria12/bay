import { addDownloadListener, cancelDownload, openDownload } from "@bay/engine";
import { Typography } from "heroui-native";
import { useEffect, useState, type JSX } from "react";
import { Pressable, View } from "react-native";

import { Surface } from "@/chrome/Surface";
import { downloadStatus } from "@/panels/DownloadsPanel";
import { useBrowserStore } from "@/store/browser";
import type { DownloadItem } from "@/store/types";

/** A finished download's toast stays this long. */
const TOAST_MS = 6000;

/** Records the engines' downloads in the store and shows the latest one as a toast above the bottom bar. */
export function useDownloads(onError: (message: string) => void) {
  const { data, dispatch } = useBrowserStore();
  const [toastId, setToastId] = useState<string | null>(null);
  const toast = data.downloads.find((item) => item.id === toastId) ?? null;

  useEffect(() => {
    const subscription = addDownloadListener((update) => {
      dispatch({ type: "download", update, now: Date.now() });
      setToastId(update.id);
    });

    return () => subscription.remove();
  }, [dispatch]);

  const settled = toast !== null && toast.state !== "downloading";
  useEffect(() => {
    if (!settled) return;
    const timer = setTimeout(() => setToastId(null), TOAST_MS);

    return () => clearTimeout(timer);
  }, [settled, toastId]);

  function open(item: DownloadItem): void {
    openDownload(item).catch((cause: unknown) => onError(cause instanceof Error ? cause.message : "Couldn't open the file."));
  }

  return {
    downloads: data.downloads,
    open,
    cancel: (item: DownloadItem) => void cancelDownload(item.id).catch(() => {}),
    remove: (item: DownloadItem) => dispatch({ type: "remove-download", id: item.id }),
    clear: () => dispatch({ type: "clear-downloads" }),
    toast,
    dismissToast: () => setToastId(null),
  };
}

export function DownloadToast({ item, onOpen, onShowAll }: { item: DownloadItem; onOpen: () => void; onShowAll: () => void }): JSX.Element {
  const progress = item.state === "downloading" && item.total ? item.received / item.total : null;

  return (
    <Surface radius={18} style={{ padding: 12 }}>
      <View className="flex-row items-center gap-3">
        <Pressable
          testID="download-toast"
          accessibilityRole="button"
          accessibilityLabel={`${item.filename}, ${downloadStatus(item)}. Show downloads`}
          onPress={onShowAll}
          className="flex-1"
        >
          <Typography numberOfLines={1} className="font-medium">
            {item.state === "finished" ? `Downloaded ${item.filename}` : item.filename}
          </Typography>
          <Typography testID="download-toast-status" numberOfLines={1} className="text-sm text-muted">
            {downloadStatus(item)}
          </Typography>
        </Pressable>
        {item.state === "finished" ? (
          <Pressable
            testID="download-toast-open"
            accessibilityRole="button"
            accessibilityLabel={`Open ${item.filename}`}
            onPress={onOpen}
            className="min-h-11 items-center justify-center rounded-full bg-default px-4"
          >
            <Typography className="text-sm">Open</Typography>
          </Pressable>
        ) : null}
      </View>
      {progress !== null ? (
        <View className="mt-2 h-1 overflow-hidden rounded-full bg-default">
          <View className="h-1 rounded-full bg-accent" style={{ width: `${Math.round(progress * 100)}%` }} />
        </View>
      ) : null}
    </Surface>
  );
}
