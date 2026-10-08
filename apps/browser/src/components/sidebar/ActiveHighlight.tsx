import { Surface } from "@bay/shell";
import { StyleSheet } from "react-native";
import Animated from "react-native-reanimated";
import { hex, useTheme } from "../../lib/theme";
import { useWindowId } from "../../store/hooks";
import { useSwitchSlide, type SlideOptions } from "../layout/switchMotion";

const ROW_SLIDE: SlideOptions = { offset: 6, duration: 150, axis: "y" };

/**
 * The active row's fill, under its content. On a tab switch the row left lets it go down (or up) the list as the row
 * switched to takes it from that side, so the selection reads as moving from one to the other.
 */
export function ActiveHighlight({ active, tabIds, borderWidth }: { active: boolean; tabIds: string[]; borderWidth: number }) {
  const slide = useSwitchSlide(useWindowId(), tabIds, active, ROW_SLIDE);
  if (!active && !slide) return null;
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, slide]}>
      <SelectedFill borderWidth={borderWidth} />
    </Animated.View>
  );
}

/** The selected row's fill, its border and glow. */
export function SelectedFill({ borderWidth }: { borderWidth: number }) {
  const theme = useTheme();
  return (
    <Surface
      fill={hex(theme.tabSelected)}
      cornerRadius={10}
      borderWidth={borderWidth}
      borderColors={theme.tabSelectedBorder.map(hex)}
      shadowColor={hex(theme.tabSelectedShadow)}
      shadowOpacity={1}
      shadowRadius={theme.tabSelectedShadowRadius}
      shadowOffset={[0, 0.5]}
      style={StyleSheet.absoluteFill}
    />
  );
}
