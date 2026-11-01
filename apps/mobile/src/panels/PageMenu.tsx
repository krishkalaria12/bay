import { Typography } from "heroui-native";
import type { JSX } from "react";
import { Pressable, View } from "react-native";

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
  onSettings: () => void;
}

function NavigationAction({
  id,
  label,
  accessibilityLabel = label,
  disabled,
  onPress,
}: {
  id: string;
  label: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  onPress: () => void;
}): JSX.Element {
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className="min-h-12 flex-1 items-center justify-center rounded-2xl bg-default px-3"
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <Typography className="text-sm">{label}</Typography>
    </Pressable>
  );
}

export function PageMenu(props: PageMenuProps): JSX.Element {
  function act(action: () => void): void {
    props.onClose();
    action();
  }
  return (
    <PanelSheet visible={props.visible} onClose={props.onClose} title="Page" testID="page-menu" height="72%">
      <Typography numberOfLines={2}>{props.title || props.url}</Typography>
      <Typography testID="page-menu-url" className="mt-1 text-sm text-muted" numberOfLines={2}>
        {props.url}
      </Typography>
      <View className="mb-2 mt-5 flex-row gap-2">
        <NavigationAction id="page-back" label="Back" disabled={!props.canGoBack} onPress={() => act(props.onBack)} />
        <NavigationAction id="page-forward" label="Forward" disabled={!props.canGoForward} onPress={() => act(props.onForward)} />
        <NavigationAction
          id={props.isLoading ? "page-stop" : "page-reload"}
          label={props.isLoading ? "Stop" : "Reload"}
          onPress={() => act(props.isLoading ? props.onStop : props.onReload)}
        />
      </View>
      <View className="mb-2 flex-row gap-2">
        <NavigationAction
          id="page-reader"
          label="Reader"
          accessibilityLabel={props.readerActive ? "Reader settings" : "Reader"}
          onPress={() => act(props.onReader)}
        />
        <NavigationAction id="page-hide-elements" label="Hide" accessibilityLabel="Hide elements" onPress={() => act(props.onHideElements)} />
        <NavigationAction id="page-markdown" label="Markdown" accessibilityLabel="Copy as Markdown" onPress={() => act(props.onCopyMarkdown)} />
      </View>
      <ActionRow testID="page-pin" label={props.isPinned ? "Unpin site" : "Pin site"} onPress={() => act(props.onPin)} />
      {props.blocking !== "off" ? (
        <ActionRow
          testID="page-blocking"
          label={props.blocking === "paused" ? "Resume blocking on this site" : "Pause blocking on this site"}
          detail={props.blocking === "paused" ? "Ads and trackers load here until you resume." : "Ads and trackers are blocked."}
          onPress={() => act(props.onToggleBlocking)}
        />
      ) : null}
      <ActionRow testID="page-copy" label="Copy link" onPress={() => act(props.onCopy)} />
      <ActionRow testID="page-share" label="Share" onPress={() => act(props.onShare)} />
      <ActionRow testID="page-settings" label="Settings" onPress={() => act(props.onSettings)} />
      <ActionRow testID="page-close-tab" label="Archive tab" destructive onPress={() => act(props.onCloseTab)} />
    </PanelSheet>
  );
}
