import { Pressable, View } from "@bay/platform";
import { Surface, Symbol } from "@bay/shell";
import { useEffect } from "react";
import { ActivityIndicator, Text } from "react-native";
import { hex, useTheme } from "../../lib/theme";
import { installUpdate, updateTitle, usePendingUpdate, watchPendingUpdate } from "../../lib/updates";
import { useHover } from "../primitives";

/** The row over the sidebar's foot while an update waits (as Arc's): "Update Bay", "Downloading Update…" with a spinner
 * while it downloads in the background, or "Restart to Update" once it's downloaded. */
export const UPDATE_ROW_HEIGHT = 40;

export function useUpdateRowShown() {
  useEffect(watchPendingUpdate, []);
  return usePendingUpdate((u) => !!u.pending);
}

export function UpdateRow() {
  const theme = useTheme();
  const pending = usePendingUpdate((u) => u.pending);
  const { hovered, hoverProps } = useHover();
  if (!pending) return null;
  const downloading = !!pending.downloading;
  const fill = (pressed: boolean) => {
    if (downloading) return theme.tabHover;
    if (pressed) return theme.tabPressed;
    return hovered ? theme.tabSelected : theme.tabHover;
  };
  return (
    <View {...hoverProps} tooltip={`Bay ${pending.version}`}>
      <Pressable onPress={installUpdate} disabled={downloading} accessibilityRole="button">
        {({ pressed }) => (
          <Surface fill={hex(fill(pressed))} cornerRadius={10} style={{ height: 32, flexDirection: "row", alignItems: "center", paddingHorizontal: 9, gap: 7 }}>
            {downloading ? (
              <View style={{ width: 18, height: 18, alignItems: "center", justifyContent: "center" }}>
                <ActivityIndicator size="small" style={{ transform: [{ scale: 0.6 }] }} />
              </View>
            ) : (
              <Symbol name="arrow.down.circle.fill" size={14} color={theme.accent} style={{ width: 18, height: 18 }} />
            )}
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, fontWeight: "600", color: theme.textPrimary }}>
              {updateTitle(pending)}
            </Text>
          </Surface>
        )}
      </Pressable>
    </View>
  );
}
