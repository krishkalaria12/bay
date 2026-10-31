import { Pressable, View } from "@bay/platform";
import Animated, { useAnimatedStyle } from "@bay/platform/motion";
import { useShallow } from "zustand/react/shallow";
import { switchSpace } from "../../lib/actions";
import { useTheme } from "../../lib/theme";
import { useBrowserRead as useBrowser } from "../../store/read";
import { usePagerOpacity, usePagerPages, type PagerPage } from "../layout/spacePager";
import { useHover } from "../primitives";
import { useSpaceDrag, useSpaceReorder, type SpaceReorder } from "./reorder";
import { DOT_HOVERED_OPACITY, DOT_IDLE_OPACITY, DOT_SELECTED_OPACITY, DOTS_BAND, DOTS_CELL, DOTS_DOT, PROFILE_DOTS_HEIGHT } from "./constants";

export function SpaceDots({ windowId }: { windowId: string }) {
  const ids = useBrowser(useShallow((s) => s.spaceOrder));
  const { pages } = usePagerPages(windowId);
  const { reorder, dragging } = useSpaceReorder(DOTS_CELL);
  return (
    <View style={{ height: PROFILE_DOTS_HEIGHT, alignItems: "center" }}>
      <View style={{ marginTop: (PROFILE_DOTS_HEIGHT - 3 - DOTS_BAND) / 2, height: DOTS_BAND, flexDirection: "row" }}>
        {ids.map((id) => (
          <Dot key={id} id={id} windowId={windowId} page={pages.find((p) => p.id === id)} reorder={reorder} lifted={dragging === id} />
        ))}
      </View>
    </View>
  );
}

// Dragged along the row, a dot reorders the spaces, as their icons do.
function Dot({ id, windowId, page, reorder, lifted }: { id: string; windowId: string; page: PagerPage | undefined; reorder: SpaceReorder; lifted: boolean }) {
  const theme = useTheme();
  const name = useBrowser((s) => s.spaces[id]?.name ?? "");
  const { hovered, hoverProps } = useHover();
  const rest = hovered || lifted ? DOT_HOVERED_OPACITY : DOT_IDLE_OPACITY;
  const opacity = usePagerOpacity(windowId, page?.slot, rest, DOT_SELECTED_OPACITY);
  const panHandlers = useSpaceDrag(reorder, id, "x");
  const offset = reorder.offsetOf(id);
  const dragStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.get() }] }), [offset]);
  return (
    <Animated.View {...panHandlers} style={[{ zIndex: lifted ? 1 : 0 }, dragStyle]}>
      <View {...hoverProps} tooltip={lifted ? undefined : name}>
        <Pressable accessibilityRole="button" accessibilityLabel={name} onPress={() => switchSpace(windowId, id, true)}>
          <View style={{ width: DOTS_CELL, height: DOTS_BAND, alignItems: "center", justifyContent: "center" }}>
            <Animated.View
              style={[{ width: DOTS_DOT, height: DOTS_DOT, borderRadius: DOTS_DOT / 2, backgroundColor: theme.dark ? "#FFFFFF" : "#000000" }, opacity]}
            />
          </View>
        </Pressable>
      </View>
    </Animated.View>
  );
}
