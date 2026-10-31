import type { JSX } from "react";
import { View } from "react-native";

import { GlassIconButton } from "./GlassIconButton";
import type { NavigationToolbarProps } from "./NavigationToolbar.types";

export function NavigationToolbar(props: NavigationToolbarProps): JSX.Element {
  return (
    <View className="flex-row items-center justify-center gap-5">
      <GlassIconButton id="browser-back" label="Back" systemImage="chevron.left" isDisabled={!props.canGoBack} onPress={props.onBack} />
      <GlassIconButton id="browser-forward" label="Forward" systemImage="chevron.right" isDisabled={!props.canGoForward} onPress={props.onForward} />
      <GlassIconButton id="browser-search" label="Search" systemImage="magnifyingglass" onPress={props.onSearch} />
      <GlassIconButton
        id={props.isLoading ? "browser-stop" : "browser-reload"}
        label={props.isLoading ? "Stop" : "Reload"}
        systemImage={props.isLoading ? "xmark" : "arrow.clockwise"}
        onPress={props.isLoading ? props.onStop : props.onReload}
      />
    </View>
  );
}
