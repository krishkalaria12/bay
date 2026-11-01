import { Typography, useThemeColor } from "heroui-native";
import { useEffect, useState, type JSX } from "react";
import { Pressable, View } from "react-native";

import { Icon } from "@/chrome/Icon";
import type { IconName } from "@/chrome/Icon.types";
import { SiteIcon } from "@/browser/SiteIcon";
import { ActionRow, Group, PanelSheet } from "./PanelSheet";

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
  disabled,
  onPress,
}: {
  id: string;
  icon: IconName;
  label: string;
  disabled?: boolean;
  onPress: () => void;
}): JSX.Element {
  const foreground = useThemeColor("foreground");
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className="h-12 flex-1 items-center justify-center rounded-full bg-default active:opacity-70"
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <Icon name={icon} color={foreground} size={22} />
    </Pressable>
  );
}

export function PageMenu(props: PageMenuProps): JSX.Element {
  // The menu keeps what people use most; the rest sits one step away in More tools.
  const [tools, setTools] = useState(false);
  useEffect(() => {
    if (props.visible) setTools(false);
  }, [props.visible]);
  function act(action: () => void): void {
    props.onClose();
    action();
  }
  if (tools) {
    return (
      <PanelSheet visible={props.visible} onClose={props.onClose} onBack={() => setTools(false)} title="More tools" testID="page-menu" height="63%">
        <Group>
          <ActionRow testID="page-copy" icon="link" label="Copy link" onPress={() => act(props.onCopy)} />
          <ActionRow testID="page-markdown" icon="markdown" label="Copy as Markdown" onPress={() => act(props.onCopyMarkdown)} />
        </Group>
        <Group>
          <ActionRow
            testID="page-hide-elements"
            icon="hide"
            label="Hide elements"
            detail="Tap things on the page to remove them"
            onPress={() => act(props.onHideElements)}
          />
          <ActionRow testID="page-inspect" icon="inspect" label="Inspect element" detail="Fonts, colours and CSS" onPress={() => act(props.onInspect)} />
        </Group>
        <Group>
          <ActionRow testID="page-history" icon="history" label="History" chevron onPress={() => act(props.onHistory)} />
          <ActionRow testID="page-settings" icon="settings" label="Settings" chevron onPress={() => act(props.onSettings)} />
        </Group>
      </PanelSheet>
    );
  }
  return (
    <PanelSheet visible={props.visible} onClose={props.onClose} title="Page" testID="page-menu" height="63%">
      <SiteHeader title={props.title} url={props.url} blocking={props.blocking} />
      <View className="mb-1 mt-4 flex-row gap-2">
        <NavigationAction id="page-back" icon="back" label="Back" disabled={!props.canGoBack} onPress={() => act(props.onBack)} />
        <NavigationAction id="page-forward" icon="forward" label="Forward" disabled={!props.canGoForward} onPress={() => act(props.onForward)} />
        <NavigationAction
          id={props.isLoading ? "page-stop" : "page-reload"}
          icon={props.isLoading ? "close" : "reload"}
          label={props.isLoading ? "Stop" : "Reload"}
          onPress={() => act(props.isLoading ? props.onStop : props.onReload)}
        />
        <NavigationAction id="page-share" icon="share" label="Share" onPress={() => act(props.onShare)} />
      </View>
      <Group>
        <ActionRow testID="page-find" icon="find" label="Find on page" onPress={() => act(props.onFind)} />
        <ActionRow testID="page-reader" icon="reader" label={props.readerActive ? "Reader settings" : "Reader"} onPress={() => act(props.onReader)} />
        <ActionRow
          testID="page-pin"
          icon={props.isPinned ? "unpin" : "pin"}
          label={props.isPinned ? "Unpin from start page" : "Pin to start page"}
          onPress={() => act(props.onPin)}
        />
        {props.blocking !== "off" ? (
          <ActionRow
            testID="page-blocking"
            icon="shield"
            label="Block ads and trackers"
            detail={props.blocking === "paused" ? "Paused on this site" : "On for this site"}
            toggle={props.blocking === "on"}
            onPress={props.onToggleBlocking}
          />
        ) : null}
        <ActionRow testID="page-more-tools" icon="more" label="More tools" chevron onPress={() => setTools(true)} />
      </Group>
      <Group>
        <ActionRow testID="page-close-tab" icon="archive" label="Archive tab" destructive onPress={() => act(props.onCloseTab)} />
      </Group>
    </PanelSheet>
  );
}

/** The page's title, its site behind a lock (or a warning when it isn't encrypted), and what's blocked. */
function SiteHeader({ title, url, blocking }: { title: string; url: string; blocking: PageMenuProps["blocking"] }): JSX.Element {
  const muted = useThemeColor("muted");
  const danger = useThemeColor("danger");
  const web = /^https?:/.test(url);
  const insecure = url.startsWith("http:");
  const status = [
    web ? (insecure ? "Not secure" : "Secure") : "",
    blocking === "on" ? "Ads and trackers blocked" : blocking === "paused" ? "Blocking paused" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View className="flex-row items-center gap-3">
      {url ? <SiteIcon url={url} size={36} /> : null}
      <View className="flex-1">
        <Typography numberOfLines={1} className="font-medium">
          {title || url}
        </Typography>
        <Typography testID="page-menu-url" numberOfLines={1} className="text-sm text-muted">
          {url}
        </Typography>
        {status ? (
          <View className="mt-0.5 flex-row items-center gap-1" accessible accessibilityLabel={status}>
            {web ? <Icon name={insecure ? "error" : "lock"} color={insecure ? danger : muted} size={12} /> : null}
            <Typography numberOfLines={1} className={insecure ? "text-xs text-danger" : "text-xs text-muted"}>
              {status}
            </Typography>
          </View>
        ) : null}
      </View>
    </View>
  );
}
