import { useEffect, useRef } from "react";
import { useColorScheme } from "react-native";
import { View, type ViewProps } from "@bay/platform";

/** The same thin, neutral track and rotating arc as the macOS ActivitySpinner. */
export function WebActivitySpinner(props: ViewProps) {
  const ring = useRef<SVGSVGElement>(null);
  const dark = useColorScheme() === "dark";
  const color = dark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.5)";
  useEffect(() => {
    const node = ring.current;
    if (!node) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let rotation: Animation | undefined;
    const update = () => {
      rotation?.cancel();
      rotation = motion.matches
        ? undefined
        : node.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 1880, iterations: Infinity });
    };
    update();
    motion.addEventListener("change", update);
    return () => {
      motion.removeEventListener("change", update);
      rotation?.cancel();
    };
  }, []);
  return (
    <View {...props} accessible={false} pointerEvents="none">
      <svg ref={ring} aria-hidden="true" width="100%" height="100%" viewBox="0 0 12 12" style={{ display: "block", transformOrigin: "center" }}>
        <circle cx="6" cy="6" r="4.75" fill="none" stroke={color} strokeWidth="1.5" opacity="0.18" />
        <circle cx="6" cy="6" r="4.75" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" pathLength="1" strokeDasharray="0.72 0.28" />
      </svg>
    </View>
  );
}
