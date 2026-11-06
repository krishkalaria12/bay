import { Typography } from "heroui-native";
import { useEffect, useState, type JSX } from "react";
import { Pressable, View } from "react-native";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";

import { PillButton } from "@/chrome/PillButton";
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
              {item.state === "downloading" ? <DownloadProgress item={item} /> : null}
            </Pressable>
            <PillButton
              compact
              testID={`download-${index}-${item.state === "downloading" ? "cancel" : "remove"}`}
              label={item.state === "downloading" ? "Cancel" : "Remove"}
              accessibilityLabel={item.state === "downloading" ? `Cancel ${item.filename}` : `Remove ${item.filename} from the list`}
              onPress={() => (item.state === "downloading" ? onCancel(item) : onRemove(item))}
            />
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

/**
 * A running download's bar: it eases to each new fraction, and while the size is unknown or the download is waiting
 * (starting, no connection) a short segment sweeps across instead, so it never looks frozen.
 */
export function DownloadProgress({ item }: { item: DownloadItem }): JSX.Element {
  const fraction = item.total && !item.waiting ? Math.min(1, item.received / item.total) : null;

  return (
    <View testID="download-progress" className="mt-2 h-1 overflow-hidden rounded-full bg-default">
      {fraction === null ? <SweepingBar /> : <FillingBar fraction={fraction} />}
    </View>
  );
}

function FillingBar({ fraction }: { fraction: number }): JSX.Element {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withTiming(fraction, { duration: 450, easing: Easing.out(Easing.cubic) });
  }, [fraction, progress]);
  const style = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));

  return <Animated.View className="h-1 rounded-full bg-accent" style={style} />;
}

const SWEEP = 0.35;

function SweepingBar(): JSX.Element {
  const [width, setWidth] = useState(0);
  const position = useSharedValue(0);
  useEffect(() => {
    position.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.cubic) }), -1, false);

    return () => cancelAnimation(position);
  }, [position]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: (position.value * (1 + SWEEP) - SWEEP) * width }] }), [width]);

  return (
    <View className="h-1 flex-1" onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <Animated.View className="h-1 rounded-full bg-accent" style={[{ width: `${SWEEP * 100}%` }, style]} />
    </View>
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
      if (item.waiting) return item.waiting;

      if (item.total) return `${Math.floor((item.received / item.total) * 100)}% · ${formatBytes(item.received)} of ${formatBytes(item.total)}`;

      return item.received ? `${formatBytes(item.received)} so far` : "Starting…";
    case "finished":
      return formatBytes(item.total || item.received);
    case "cancelled":
      return "Cancelled";
    case "failed":
      return item.error ?? "Failed";
  }
}
