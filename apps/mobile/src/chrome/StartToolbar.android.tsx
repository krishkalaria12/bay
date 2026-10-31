import { useThemeColor } from "heroui-native";
import type { JSX } from "react";
import { Pressable, View } from "react-native";

import { MaterialSymbol, type MaterialSymbolName } from "./MaterialSymbol";

// Same layout as iOS (Lens: three round buttons), drawn the way Arc Search does on Android: our own flat views with a
// translucent fill and hairline edge, no Material components and no imitation glass.
function RoundButton({ icon, label }: { icon: MaterialSymbolName; label: string }): JSX.Element {
  const foreground = useThemeColor("foreground");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      className="size-[52px] items-center justify-center rounded-full border border-black/5 bg-black/5 active:bg-black/10"
    >
      <MaterialSymbol name={icon} color={foreground} />
    </Pressable>
  );
}

export function StartToolbar(): JSX.Element {
  return (
    <View className="mb-2 flex-row justify-center gap-7">
      <RoundButton icon="archive" label="Archive" />
      <RoundButton icon="search" label="Search" />
      <RoundButton icon="settings" label="Settings" />
    </View>
  );
}
