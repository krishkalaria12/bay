import type { JSX } from "react";
import { useEffect, useRef } from "react";
import { Image, StyleSheet, useWindowDimensions } from "react-native";
import Animated, { interpolate, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import { SETTLE, useReducedMotion } from "@/chrome/motion";

/** Where a rectangle sits on the screen. */
export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TabZoomProps {
  /** The tab's last snapshot: the picture the card in the switcher shows. */
  snapshot: string;
  /** Where the picture starts: the card's frame on the screen. */
  from: Frame;
  /** Called when the zoom is over. */
  onDone: () => void;
}

/**
 * The card's picture, grown into the page (A1): the switcher's card zooms into the page it stands for, and the live
 * view takes over when the zoom is over.
 */
export function TabZoom({ snapshot, from, onDone }: TabZoomProps): JSX.Element {
  const { width, height } = useWindowDimensions();
  const progress = useSharedValue(0);
  const reduced = useReducedMotion();
  // The zoom runs once. The caller's handler changes with every render, so it is kept here instead of in the effect's
  // dependencies: a changing handler would start the zoom over, and it would never arrive.
  const finish = useRef(onDone);

  finish.current = onDone;

  useEffect(() => {
    progress.value = withTiming(1, { ...SETTLE, duration: reduced ? 0 : SETTLE.duration }, (finished) => {
      if (finished) scheduleOnRN(() => finish.current());
    });
  }, [progress, reduced]);

  const style = useAnimatedStyle(() => {
    const at = progress.value;
    // The picture is drawn over the whole screen and moved and scaled into the frame it belongs to.
    const x = interpolate(at, [0, 1], [from.x, 0]);
    const y = interpolate(at, [0, 1], [from.y, 0]);
    const w = interpolate(at, [0, 1], [from.width, width]);
    const h = interpolate(at, [0, 1], [from.height, height]);
    // The frame's middle ends in the screen's middle.
    const shiftX = x + w / 2 - width / 2;
    const shiftY = y + h / 2 - height / 2;

    return {
      // The picture keeps the card's round corners while it is small, and loses them as it fills the screen.
      borderRadius: interpolate(w / width, [0.5, 1], [22, 0]),
      transform: [{ translateX: shiftX }, { translateY: shiftY }, { scale: w / width }],
    };
  });

  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.picture, style]}>
      <Image source={{ uri: snapshot }} resizeMode="cover" style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  picture: {
    overflow: "hidden",
    backgroundColor: "#FFFFFF",
  },
});
