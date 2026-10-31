import type { JSX } from "react";
import { View } from "react-native";

import { GlassIconButton } from "./GlassIconButton";
import type { StartToolbarProps } from "./StartToolbar.types";

// iOS: SwiftUI Liquid Glass buttons.
export function StartToolbar({ onSearch }: StartToolbarProps): JSX.Element {
  return (
    <View className="mb-2 flex-row items-center justify-center gap-7">
      <GlassIconButton id="start-archive" systemImage="archivebox" label="Archive" />
      <GlassIconButton id="start-search" systemImage="magnifyingglass" label="Search" onPress={onSearch} />
      <GlassIconButton id="start-settings" systemImage="gearshape" label="Settings" />
    </View>
  );
}
