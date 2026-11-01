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
  iconOnly = false,
  onPress,
}: {
  id: string;
  icon: IconName;
  label: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  /** A slim round button with just the icon (back, forward, reload, share). */
  iconOnly?: boolean;
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
      className={
        iconOnly
          ? "h-11 flex-1 items-center justify-center rounded-full bg-default active:opacity-70"
          : "min-h-[60px] flex-1 items-center justify-center gap-1 rounded-2xl bg-default px-1 active:opacity-70"
      }
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <Icon name={icon} color={foreground} size={iconOnly ? 22 : 20} />
      {iconOnly ? null : (
        <Typography numberOfLines={1} style={{ fontSize: 11 }}>
          {label}
        </Typography>
      )}
    </Pressable>
  );
}

export function PageMenu(props: PageMenuProps): JSX.Element {
  function act(action: () => void): void {
    props.onClose();
    action();
  }
  return (
    <PanelSheet visible={props.visible} onClose={props.onClose} title="Page" testID="page-menu" height="63%">
      <SiteHeader title={props.title} url={props.url} />
      <View className="mb-3 mt-4 flex-row gap-2">
        <NavigationAction id="page-back" icon="back" label="Back" iconOnly disabled={!props.canGoBack} onPress={() => act(props.onBack)} />
        <NavigationAction id="page-forward" icon="forward" label="Forward" iconOnly disabled={!props.canGoForward} onPress={() => act(props.onForward)} />
        <NavigationAction
          id={props.isLoading ? "page-stop" : "page-reload"}
          icon={props.isLoading ? "close" : "reload"}
          label={props.isLoading ? "Stop" : "Reload"}
          iconOnly
          onPress={() => act(props.isLoading ? props.onStop : props.onReload)}
        />
        <NavigationAction id="page-share" icon="share" label="Share" iconOnly onPress={() => act(props.onShare)} />
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
        <NavigationAction id="page-hide-elements" icon="hide" label="Hide" accessibilityLabel="Hide elements" onPress={() => act(props.onHideElements)} />
        <NavigationAction id="page-inspect" icon="inspect" label="Inspect" accessibilityLabel="Inspect element" onPress={() => act(props.onInspect)} />
      </View>
      <View className="mb-2 flex-row gap-2">
        <NavigationAction id="page-markdown" icon="markdown" label="Markdown" accessibilityLabel="Copy as Markdown" onPress={() => act(props.onCopyMarkdown)} />
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

/** The page's title, and its address behind a lock (or a warning when it isn't encrypted). */
function SiteHeader({ title, url }: { title: string; url: string }): JSX.Element {
  const muted = useThemeColor("muted");
  const danger = useThemeColor("danger");
  const insecure = url.startsWith("http:");
  return (
    <View className="flex-row items-center gap-3">
      {url ? <SiteIcon url={url} size={32} /> : null}
      <View className="flex-1">
        <Typography numberOfLines={1} className="font-medium">
          {title || url}
        </Typography>
        <View className="mt-0.5 flex-row items-center gap-1">
          {/^https?:/.test(url) ? (
            <View accessible accessibilityLabel={insecure ? "Not secure" : "Secure connection"}>
              <Icon name={insecure ? "error" : "lock"} color={insecure ? danger : muted} size={13} />
            </View>
          ) : null}
          <Typography testID="page-menu-url" numberOfLines={1} className="flex-1 text-sm text-muted">
            {url}
          </Typography>
        </View>
      </View>
    </View>
  );
}
