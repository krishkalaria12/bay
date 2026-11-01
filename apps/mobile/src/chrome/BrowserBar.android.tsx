import { useThemeColor } from "heroui-native";
import type { JSX } from "react";
import { Pressable, Text, View } from "react-native";

import { barButtons, barSite, type BarButton, type BrowserBarProps } from "./BrowserBar.types";
import { MaterialSymbol, type MaterialSymbolName } from "./MaterialSymbol";
import { TabCount } from "./TabCount";

// Same layout as iOS, drawn the way Arc Search does on Android: flat translucent buttons with a hairline edge.
function BarPressable({
  button,
  icon,
  wide = false,
  text,
  privately = false,
}: {
  button: BarButton;
  icon: MaterialSymbolName;
  wide?: boolean;
  /** Shown in place of the icon. */
  text?: string;
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
      onLongPress={button.onLongPress}
      className={
        privately
          ? "h-[52px] items-center justify-center rounded-full border border-white/10 bg-neutral-900/95 active:bg-neutral-800/95"
          : "h-[52px] items-center justify-center rounded-full border border-black/10 bg-white/90 active:bg-neutral-200/90 dark:border-white/10 dark:bg-neutral-900/90 dark:active:bg-neutral-800/90"
      }
      style={{ width: wide ? (text ? 172 : 128) : 52 }}
    >
      {text ? (
        <Text numberOfLines={1} style={{ color: foreground, fontSize: 15, fontWeight: "500", paddingHorizontal: 14 }}>
          {text}
        </Text>
      ) : (
        <MaterialSymbol name={icon} color={foreground} size={22} />
      )}
      {button.badge ? <TabCount count={button.badge} /> : null}
    </Pressable>
  );
}

export function BrowserBar(props: BrowserBarProps): JSX.Element {
  const [left, search, right] = barButtons(props);
  return (
    <View className="flex-row items-center justify-center gap-4">
      <BarPressable button={left} icon={left.icon} privately={props.privately} />
      <BarPressable button={search} icon="search" wide text={barSite(props)} privately={props.privately} />
      <BarPressable button={right} icon={right.icon} privately={props.privately} />
    </View>
  );
}
