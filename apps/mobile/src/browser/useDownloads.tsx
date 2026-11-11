import { addDownloadListener, cancelDownload, openDownload } from "@bay/engine";
import { Typography, useThemeColor } from "heroui-native";
import { useEffect, useState, type JSX } from "react";
import { PermissionsAndroid, Platform, Pressable, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeInDown,
  FadeOutDown,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  ZoomIn,
} from "react-native-reanimated";

import { Icon } from "@/chrome/Icon";
import { PillButton } from "@/chrome/PillButton";
import { Surface } from "@/chrome/Surface";
import { announce } from "@/chrome/screenReader";
import { t as translate, useT } from "@/i18n";
import { DownloadProgress, downloadStatus } from "@/panels/DownloadsPanel";
import { useBrowserStore } from "@/store/browser";
import type { DownloadItem } from "@/store/types";

/** A finished download's toast stays this long. */
const TOAST_MS = 6000;

let askedToNotify = false;

/** Android 13+ hides the download progress notification until Bay may post notifications; asks once per launch. */
function askToNotify(): void {
  if (askedToNotify || Platform.OS !== "android" || Number(Platform.Version) < 33) return;
  askedToNotify = true;
  void PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => {});
}

/** Records the engines' downloads in the store and shows the latest one as a toast above the bottom bar. */
export function useDownloads(onError: (message: string) => void) {
  const { data, dispatch } = useBrowserStore();
  const [toastId, setToastId] = useState<string | null>(null);
  const toast = data.downloads.find((item) => item.id === toastId) ?? null;

  useEffect(() => {
    const subscription = addDownloadListener((update) => {
      if (update.state === "started") askToNotify();
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
    openDownload(item).catch((cause: unknown) => onError(cause instanceof Error ? cause.message : translate("toast.fileNotOpened")));
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
  const t = useT();
  const status = downloadStatus(item, t);
  const heading = item.state === "finished" ? t("downloadToast.downloaded", { filename: item.filename }) : item.filename;

  // Read out when the download starts and when it ends, not with every progress step.
  useEffect(() => {
    announce(item.state === "downloading" ? item.filename : `${heading}. ${status}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.state]);

  return (
    <Animated.View entering={FadeInDown.springify().damping(18)} exiting={FadeOutDown.duration(180)}>
      <Surface radius={18} style={{ padding: 12 }}>
        <View className="flex-row items-center gap-3">
          <DownloadBadge key={item.state} state={item.state} />
          <Pressable
            testID="download-toast"
            accessibilityRole="button"
            accessibilityLabel={t("downloadToast.showAll", { filename: item.filename, status })}
            onPress={onShowAll}
            className="flex-1"
          >
            <Typography numberOfLines={1} className="font-medium">
              {heading}
            </Typography>
            <Typography testID="download-toast-status" numberOfLines={1} className="text-sm text-muted">
              {status}
            </Typography>
          </Pressable>
          {item.state === "finished" ? (
            <Animated.View entering={FadeIn.duration(200)}>
              <PillButton
                testID="download-toast-open"
                label={t("downloadToast.open")}
                accessibilityLabel={t("downloadToast.openLabel", { filename: item.filename })}
                onPress={onOpen}
              />
            </Animated.View>
          ) : null}
        </View>
        {item.state === "downloading" ? <DownloadProgress item={item} /> : null}
      </Surface>
    </Animated.View>
  );
}

/** The toast's icon: an arrow that bobs while the file comes in, a check that pops in when it's saved. */
function DownloadBadge({ state }: { state: DownloadItem["state"] }): JSX.Element {
  const accent = useThemeColor("accent");
  const muted = useThemeColor("muted");
  const danger = useThemeColor("danger");
  const bob = useSharedValue(0);
  useEffect(() => {
    if (state !== "downloading") return;
    bob.value = withRepeat(withTiming(1, { duration: 650, easing: Easing.inOut(Easing.quad) }), -1, true);

    return () => cancelAnimation(bob);
  }, [state, bob]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: bob.value * 3 - 1.5 }] }));

  const icon =
    state === "downloading" ? (
      <Animated.View style={style}>
        <Icon name="download" color={accent} size={22} />
      </Animated.View>
    ) : state === "finished" ? (
      <Animated.View entering={ZoomIn.springify().damping(12)}>
        <Icon name="check" color={accent} size={22} />
      </Animated.View>
    ) : (
      <Icon name="error" color={state === "failed" ? danger : muted} size={22} />
    );

  return <View className="size-9 items-center justify-center rounded-full bg-default">{icon}</View>;
}
