import { useThemeColor } from "heroui-native";
import type { JSX } from "react";
import { Pressable, Text, View } from "react-native";
import Animated from "react-native-reanimated";

import { barButtons, barInsecure, barNewTab, barSite, type BarButton, type BrowserBarProps } from "./BrowserBar.types";
import { MaterialSymbol, type MaterialSymbolName } from "./MaterialSymbol";
import { TabCount } from "./TabCount";

// Same layout as iOS, drawn the way Arc Search does on Android: flat translucent buttons with a hairline edge.
function BarPressable({
  button,
  icon,
  wide = false,
  text,
  insecure = false,
  leading,
  privately = false,
}: {
  button: BarButton;
  icon: MaterialSymbolName;
  wide?: boolean;
  /** Shown in place of the icon. */
  text?: string;
  /** A warning before the text. */
  insecure?: boolean;
  /** An icon before the text. */
  leading?: MaterialSymbolName;
  privately?: boolean;
}): JSX.Element {
  const themeForeground = useThemeColor("foreground");
  const foreground = privately ? "#F4F4F5" : themeForeground;
  const danger = useThemeColor("danger");
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
        <View className="flex-row items-center gap-1 px-3.5">
          {insecure ? <MaterialSymbol name="error" color={danger} size={16} /> : null}
          {leading ? <MaterialSymbol name={leading} color={foreground} size={20} /> : null}
          <Text numberOfLines={1} className="shrink" style={{ color: foreground, fontSize: 15, fontWeight: "500" }}>
            {text}
          </Text>
        </View>
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
      <Animated.View style={props.capsuleStyle}>
        <BarPressable
          button={search}
          icon="search"
          wide
          text={barNewTab(props) ? "New tab" : barSite(props)}
          leading={barNewTab(props) ? "add" : undefined}
          insecure={barInsecure(props)}
          privately={props.privately}
        />
      </Animated.View>
      <BarPressable button={right} icon={right.icon} privately={props.privately} />
    </View>
  );
}
