import { useBottomSheetScrollableCreator } from "@gorhom/bottom-sheet";
import { LegendList } from "@legendapp/list/react-native";
import { Typography } from "heroui-native";
import { useEffect, useState, type JSX } from "react";
import { Pressable, View } from "react-native";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PillButton } from "@/chrome/PillButton";
import { formatNumber, useT, type Translate } from "@/i18n";
import { INTERRUPTED_DOWNLOAD } from "@/store/model";
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
  const insets = useSafeAreaInsets();
  const Scrollable = useBottomSheetScrollableCreator();
  const t = useT();

  return (
    <PanelSheet visible={visible} onClose={onClose} title={t("downloads.title")} testID="downloads-panel" height="70%" listMode>
      {downloads.length ? (
        <LegendList
          data={downloads}
          keyExtractor={(item) => item.id}
          estimatedItemSize={56}
          keyboardShouldPersistTaps="handled"
          renderScrollComponent={Scrollable}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: Math.max(insets.bottom, 20) + 12 }}
          ListFooterComponent={
            downloads.some((item) => item.state !== "downloading") ? (
              <ActionRow testID="downloads-clear" label={t("downloads.clearList")} onPress={onClear} />
            ) : null
          }
          renderItem={({ item, index }) => (
            <View className="flex-row items-center gap-2 border-b border-foreground/5">
              <Pressable
                testID={`download-${index}`}
                accessibilityRole="button"
                accessibilityLabel={`${item.filename}, ${downloadStatus(item, t)}`}
                accessibilityState={{ disabled: item.state !== "finished" }}
                disabled={item.state !== "finished"}
                onPress={() => onOpen(item)}
                className="min-h-14 flex-1 justify-center py-2"
              >
                <Typography numberOfLines={1}>{item.filename}</Typography>
                <Typography testID={`download-${index}-status`} numberOfLines={1} className="text-sm text-muted">
                  {downloadStatus(item, t)}
                </Typography>
                {item.state === "downloading" ? <DownloadProgress item={item} /> : null}
              </Pressable>
              <PillButton
                compact
                testID={`download-${index}-${item.state === "downloading" ? "cancel" : "remove"}`}
                label={item.state === "downloading" ? t("downloads.cancel") : t("downloads.remove")}
                accessibilityLabel={
                  item.state === "downloading"
                    ? t("downloads.cancelLabel", { filename: item.filename })
                    : t("downloads.removeLabel", { filename: item.filename })
                }
                onPress={() => (item.state === "downloading" ? onCancel(item) : onRemove(item))}
              />
            </View>
          )}
          style={{ flex: 1 }}
        />
      ) : (
        <Typography testID="downloads-empty" className="text-muted">
          {t("downloads.empty")}
        </Typography>
      )}
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
    // The status line beside it says the percentage in words, so readers skip the bar.
    <View
      testID="download-progress"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="mt-2 h-1 overflow-hidden rounded-full bg-default"
    >
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

const ONE_DECIMAL = { minimumFractionDigits: 1, maximumFractionDigits: 1 } as const;

/** "1.2 MB", "340 KB", with the number written the current language's way. */
export function formatBytes(bytes: number, t: Translate): string {
  if (bytes >= 1_000_000_000) return `${formatNumber(bytes / 1_000_000_000, ONE_DECIMAL)} GB`;

  if (bytes >= 1_000_000) return `${formatNumber(bytes / 1_000_000, ONE_DECIMAL)} MB`;

  if (bytes >= 1_000) return `${formatNumber(Math.round(bytes / 1_000))} KB`;

  return t("downloads.size.bytes", { size: formatNumber(bytes) });
}

/** What a download is doing, in a few words. */
export function downloadStatus(item: DownloadItem, t: Translate): string {
  switch (item.state) {
    case "downloading":
      if (item.waiting) return item.waiting;

      if (item.total) {
        return t("downloads.status.progress", {
          percent: formatNumber(Math.floor((item.received / item.total) * 100)),
          received: formatBytes(item.received, t),
          total: formatBytes(item.total, t),
        });
      }

      return item.received ? t("downloads.status.soFar", { size: formatBytes(item.received, t) }) : t("downloads.status.starting");
    case "finished":
      return formatBytes(item.total || item.received, t);
    case "cancelled":
      return t("downloads.status.cancelled");
    case "failed":
      // Bay's own note is saved in English; the engine's messages arrive in the device's language already.
      return item.error === INTERRUPTED_DOWNLOAD ? t("downloads.interrupted") : (item.error ?? t("downloads.status.failed"));
  }
}
