import { useThemeColor } from "heroui-native";
import type { JSX } from "react";
import { Pressable, View } from "react-native";

import { barButtons, type BarButton, type BrowserBarProps } from "./BrowserBar.types";
import { MaterialSymbol, type MaterialSymbolName } from "./MaterialSymbol";

// Same layout as iOS, drawn the way Arc Search does on Android: flat translucent buttons with a hairline edge.
function BarPressable({
  button,
  icon,
  wide = false,
  privately = false,
}: {
  button: BarButton;
  icon: MaterialSymbolName;
  wide?: boolean;
  privately?: boolean;
}): JSX.Element {
  const themeForeground = useThemeColor("foreground");
  const foreground = privately ? "#F4F4F5" : themeForeground;
  return (
    <Pressable
      testID={button.id}
      accessibilityRole="button"
      accessibilityLabel={button.label}
      onPress={button.onPress}
      className={
        privately
          ? "h-[52px] items-center justify-center rounded-full border border-white/10 bg-neutral-900/95 active:bg-neutral-800/95"
          : "h-[52px] items-center justify-center rounded-full border border-black/10 bg-white/90 active:bg-neutral-200/90 dark:border-white/10 dark:bg-neutral-900/90 dark:active:bg-neutral-800/90"
      }
      style={{ width: wide ? 128 : 52 }}
    >
      <MaterialSymbol name={icon} color={foreground} size={22} />
    </Pressable>
  );
}

export function BrowserBar(props: BrowserBarProps): JSX.Element {
  const [left, search, right] = barButtons(props);
  return (
    <View className="flex-row items-center justify-center gap-4">
      <BarPressable button={left} icon={left.icon} privately={props.privately} />
      <BarPressable button={search} icon="search" wide privately={props.privately} />
      <BarPressable button={right} icon={right.icon} privately={props.privately} />
    </View>
  );
}
