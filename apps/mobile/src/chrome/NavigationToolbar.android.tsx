import { Typography } from "heroui-native";
import type { JSX } from "react";
import { Pressable, View } from "react-native";

import type { NavigationToolbarProps } from "./NavigationToolbar.types";

function NavigationButton({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }): JSX.Element {
  return (
    <Pressable
      testID={`browser-${label.toLowerCase()}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className="min-h-12 min-w-12 items-center justify-center rounded-full border border-black/5 bg-black/5 px-3 active:bg-black/10"
      style={{ opacity: disabled ? 0.35 : 1 }}
    >
      <Typography>{label}</Typography>
    </Pressable>
  );
}

export function NavigationToolbar(props: NavigationToolbarProps): JSX.Element {
  return (
    <View className="flex-row justify-center gap-3">
      <NavigationButton label="Back" disabled={!props.canGoBack} onPress={props.onBack} />
      <NavigationButton label="Forward" disabled={!props.canGoForward} onPress={props.onForward} />
      <NavigationButton label="Search" onPress={props.onSearch} />
      <NavigationButton label={props.isLoading ? "Stop" : "Reload"} onPress={props.isLoading ? props.onStop : props.onReload} />
    </View>
  );
}
