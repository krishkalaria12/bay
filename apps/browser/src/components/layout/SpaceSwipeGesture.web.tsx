import { View } from "@bay/platform";
import { useEffect, useRef } from "react";
import { StyleSheet } from "react-native";
import { bindSpaceGestures, type SpaceSwipeGestureProps } from "./webSpaceGestures";

export function SpaceSwipeGesture(props: SpaceSwipeGestureProps) {
  const anchor = useRef<View>(null);
  const current = useRef(props);
  current.current = props;
  useEffect(() => {
    const node = anchor.current;
    if (node instanceof HTMLElement && node.parentElement) return bindSpaceGestures(node.parentElement, () => current.current);
  }, []);
  // The transparent native overlay cannot receive DOM wheel events. Listen on
  // its containing surface instead, leaving every sidebar control clickable.
  return <View ref={anchor} pointerEvents="none" style={StyleSheet.absoluteFill} />;
}
