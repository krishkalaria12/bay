import { AccessibilityInfo } from "react-native";

// The system's Reduce Motion setting, kept current: read where a motion starts, so no component re-renders for it.
let reduced = false;
AccessibilityInfo.isReduceMotionEnabled().then(
  (on) => (reduced = on),
  () => {},
);
AccessibilityInfo.addEventListener("reduceMotionChanged", (on) => (reduced = on));

export const reduceMotion = () => reduced;
