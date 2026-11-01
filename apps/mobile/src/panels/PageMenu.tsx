import { Typography, useThemeColor } from "heroui-native";
import type { JSX } from "react";
import { Pressable, View } from "react-native";

import { Icon } from "@/chrome/Icon";
import type { IconName } from "@/chrome/Icon.types";
import { SiteIcon } from "@/browser/SiteIcon";
import { ActionRow, PanelSheet } from "./PanelSheet";

export interface PageMenuProps {
  visible: boolean;
  onClose: () => void;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  isPinned: boolean;
  /** Ad and tracker blocking on this site; "off" when it's turned off in Settings. */
  blocking: "on" | "paused" | "off";
  onToggleBlocking: () => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
  onPin: () => void;
  onShare: () => void;
  onCopy: () => void;
  onCloseTab: () => void;
  readerActive: boolean;
  onReader: () => void;
  onHideElements: () => void;
  onCopyMarkdown: () => void;
  onFind: () => void;
  onInspect: () => void;
  onSettings: () => void;
  onHistory: () => void;
}

function NavigationAction({
  id,
  icon,
  label,
  accessibilityLabel = label,
  disabled,
  onPress,
}: {
  id: string;
  icon: IconName;
  label: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  onPress: () => void;
}): JSX.Element {
  const foreground = useThemeColor("foreground");
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className="min-h-[68px] flex-1 items-center justify-center gap-1.5 rounded-2xl bg-default px-2 active:opacity-70"
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <Icon name={icon} color={foreground} size={22} />
      <Typography className="text-xs">{label}</Typography>
    </Pressable>
  );
}

export function PageMenu(props: PageMenuProps): JSX.Element {
  function act(action: () => void): void {
    props.onClose();
    action();
  }
  return (
    <PanelSheet visible={props.visible} onClose={props.onClose} title="Page" testID="page-menu" height="80%">
      <View className="flex-row gap-3">
        {props.url ? <SiteIcon url={props.url} size={36} /> : null}
        <View className="flex-1">
          <Typography numberOfLines={2}>{props.title || props.url}</Typography>
          <Typography testID="page-menu-url" className="mt-1 text-sm text-muted" numberOfLines={2}>
            {props.url}
          </Typography>
          <SiteStatus url={props.url} blocking={props.blocking} />
        </View>
      </View>
      <View className="mb-2 mt-5 flex-row gap-2">
        <NavigationAction id="page-back" icon="back" label="Back" disabled={!props.canGoBack} onPress={() => act(props.onBack)} />
        <NavigationAction id="page-forward" icon="forward" label="Forward" disabled={!props.canGoForward} onPress={() => act(props.onForward)} />
        <NavigationAction
          id={props.isLoading ? "page-stop" : "page-reload"}
          icon={props.isLoading ? "close" : "reload"}
          label={props.isLoading ? "Stop" : "Reload"}
          onPress={() => act(props.isLoading ? props.onStop : props.onReload)}
        />
      </View>
      <View className="mb-2 flex-row gap-2">
        <NavigationAction
          id="page-reader"
          icon="reader"
          label="Reader"
          accessibilityLabel={props.readerActive ? "Reader settings" : "Reader"}
          onPress={() => act(props.onReader)}
        />
        <NavigationAction id="page-find" icon="find" label="Find" accessibilityLabel="Find on page" onPress={() => act(props.onFind)} />
        <NavigationAction id="page-inspect" icon="inspect" label="Inspect" accessibilityLabel="Inspect element" onPress={() => act(props.onInspect)} />
      </View>
      <View className="mb-2 flex-row gap-2">
        <NavigationAction id="page-hide-elements" icon="hide" label="Hide" accessibilityLabel="Hide elements" onPress={() => act(props.onHideElements)} />
        <NavigationAction id="page-markdown" icon="markdown" label="Markdown" accessibilityLabel="Copy as Markdown" onPress={() => act(props.onCopyMarkdown)} />
        <NavigationAction id="page-share" icon="share" label="Share" onPress={() => act(props.onShare)} />
      </View>
      <View className="mb-2 flex-row gap-2">
        <NavigationAction id="page-copy" icon="link" label="Copy link" onPress={() => act(props.onCopy)} />
        <NavigationAction id="page-history" icon="history" label="History" onPress={() => act(props.onHistory)} />
        <NavigationAction id="page-settings" icon="settings" label="Settings" onPress={() => act(props.onSettings)} />
      </View>
      <ActionRow
        testID="page-pin"
        icon={props.isPinned ? "unpin" : "pin"}
        label={props.isPinned ? "Unpin site" : "Pin site"}
        onPress={() => act(props.onPin)}
      />
      {props.blocking !== "off" ? (
        <ActionRow
          testID="page-blocking"
          icon="shield"
          label={props.blocking === "paused" ? "Resume blocking on this site" : "Pause blocking on this site"}
          detail={props.blocking === "paused" ? "Ads and trackers load here until you resume." : "Ads and trackers are blocked."}
          onPress={() => act(props.onToggleBlocking)}
        />
      ) : null}
      <ActionRow testID="page-close-tab" icon="archive" label="Archive tab" destructive onPress={() => act(props.onCloseTab)} />
    </PanelSheet>
  );
}

/** Whether the connection is encrypted, and what the blocker is doing here. */
function SiteStatus({ url, blocking }: { url: string; blocking: PageMenuProps["blocking"] }): JSX.Element | null {
  const muted = useThemeColor("muted");
  const danger = useThemeColor("danger");
  if (!/^https?:/.test(url)) return null;
  const secure = url.startsWith("https:");
  const blocker = { on: "Ads and trackers blocked", paused: "Blocking paused here", off: "Blocking off" }[blocking];
  return (
    <View testID="page-site-status" className="mt-2 flex-row items-center gap-1.5">
      <Icon name={secure ? "lock" : "error"} color={secure ? muted : danger} size={15} />
      <Typography className={secure ? "text-xs text-muted" : "text-xs text-danger"}>
        {secure ? "Secure connection" : "Not secure"} · {blocker}
      </Typography>
    </View>
  );
}
