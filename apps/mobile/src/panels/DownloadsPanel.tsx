import { Typography } from "heroui-native";
import type { JSX } from "react";
import { Pressable, View } from "react-native";

import type { DownloadItem } from "@/store/types";

import { ActionRow, PanelSheet } from "./PanelSheet";

export interface DownloadsPanelProps {
  visible: boolean;
  onClose: () => void;
  downloads: readonly DownloadItem[];
  onOpen: (item: DownloadItem) => void;
  onCancel: (item: DownloadItem) => void;
  onRemove: (item: DownloadItem) => void;
  onClear: () => void;
}

/** Downloads, newest first: tap a finished one to open it. Removing one only takes it off the list. */
export function DownloadsPanel({ visible, onClose, downloads, onOpen, onCancel, onRemove, onClear }: DownloadsPanelProps): JSX.Element {
  return (
    <PanelSheet visible={visible} onClose={onClose} title="Downloads" testID="downloads-panel" height="70%">
      {downloads.length ? (
        downloads.map((item, index) => (
          <View key={item.id} className="flex-row items-center gap-2 border-b border-foreground/5">
            <Pressable
              testID={`download-${index}`}
              accessibilityRole="button"
              accessibilityLabel={`${item.filename}, ${downloadStatus(item)}`}
              accessibilityState={{ disabled: item.state !== "finished" }}
              disabled={item.state !== "finished"}
              onPress={() => onOpen(item)}
              className="min-h-14 flex-1 justify-center py-2"
            >
              <Typography numberOfLines={1}>{item.filename}</Typography>
              <Typography testID={`download-${index}-status`} numberOfLines={1} className="text-sm text-muted">
                {downloadStatus(item)}
              </Typography>
            </Pressable>
            <Pressable
              testID={`download-${index}-${item.state === "downloading" ? "cancel" : "remove"}`}
              accessibilityRole="button"
              accessibilityLabel={item.state === "downloading" ? `Cancel ${item.filename}` : `Remove ${item.filename} from the list`}
              onPress={() => (item.state === "downloading" ? onCancel(item) : onRemove(item))}
              className="min-h-11 items-center justify-center rounded-full bg-default px-3"
            >
              <Typography className="text-sm">{item.state === "downloading" ? "Cancel" : "Remove"}</Typography>
            </Pressable>
          </View>
        ))
      ) : (
        <Typography testID="downloads-empty" className="text-muted">
          Files you download appear here.
        </Typography>
      )}
      {downloads.some((item) => item.state !== "downloading") ? <ActionRow testID="downloads-clear" label="Clear list" onPress={onClear} /> : null}
    </PanelSheet>
  );
}

/** "1.2 MB", "340 KB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} bytes`;
}

/** What a download is doing, in a few words. */
export function downloadStatus(item: DownloadItem): string {
  switch (item.state) {
    case "downloading":
      return item.total ? `${formatBytes(item.received)} of ${formatBytes(item.total)}` : `${formatBytes(item.received)} so far`;
    case "finished":
      return formatBytes(item.total || item.received);
    case "cancelled":
      return "Cancelled";
    case "failed":
      return item.error ?? "Failed";
  }
}
