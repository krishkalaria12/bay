import { Pressable, View } from "react-native";
import Animated from "react-native-reanimated";
import { useShallow } from "zustand/react/shallow";
import { switchSpace } from "../../lib/actions";
import { useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { usePagerOpacity, usePagerPages, type PagerPage } from "../layout/spacePager";
import { useHover } from "../primitives";
import { DOT_HOVERED_OPACITY, DOT_IDLE_OPACITY, DOT_SELECTED_OPACITY, DOTS_BAND, DOTS_CELL, DOTS_DOT, PROFILE_DOTS_HEIGHT } from "./constants";

export function SpaceDots({ windowId }: { windowId: string }) {
  const ids = useBrowser(useShallow((s) => s.spaceOrder));
  const { pages } = usePagerPages(windowId);
  return (
    <View style={{ height: PROFILE_DOTS_HEIGHT, alignItems: "center" }}>
      <View style={{ marginTop: (PROFILE_DOTS_HEIGHT - 3 - DOTS_BAND) / 2, height: DOTS_BAND, flexDirection: "row" }}>
        {ids.map((id) => (
          <Dot key={id} id={id} windowId={windowId} page={pages.find((p) => p.id === id)} />
        ))}
      </View>
    </View>
  );
}

function Dot({ id, windowId, page }: { id: string; windowId: string; page: PagerPage | undefined }) {
  const theme = useTheme();
  const name = useBrowser((s) => s.spaces[id]?.name ?? "");
  const { hovered, hoverProps } = useHover();
  const rest = hovered ? DOT_HOVERED_OPACITY : DOT_IDLE_OPACITY;
  const opacity = usePagerOpacity(windowId, page?.slot, rest, DOT_SELECTED_OPACITY);
  return (
    <View {...hoverProps} tooltip={name}>
      <Pressable accessibilityRole="button" accessibilityLabel={name} onPress={() => switchSpace(windowId, id, true)}>
        <View style={{ width: DOTS_CELL, height: DOTS_BAND, alignItems: "center", justifyContent: "center" }}>
          <Animated.View
            style={[{ width: DOTS_DOT, height: DOTS_DOT, borderRadius: DOTS_DOT / 2, backgroundColor: theme.dark ? "#FFFFFF" : "#000000" }, opacity]}
          />
        </View>
      </Pressable>
    </View>
  );
}
