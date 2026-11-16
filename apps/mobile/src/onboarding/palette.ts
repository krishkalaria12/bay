import { useColorScheme } from "react-native";

// The first run's colours: Bay's paper and ink, with the icon's evening in it. Yab draws its ground in the system's blue;
// Bay's comes from its icon instead: the setting sun's coral glowing at the top by day, dusk's violet by night.

export interface FirstRunColors {
  /** The ground at the bottom of the screen, and at its top before the glow. */
  ground: string;
  groundTop: string;
  /** The glow at the top of the screen. */
  glow: string;
  /** The ground's dots. */
  dot: string;
  /** Titles and anything read first. */
  ink: string;
  /** The words under a title: opaque, so they keep their contrast over the glow. */
  words: string;
  /** Placeholders, the dots not on screen, hairlines. */
  faint: string;
  /** The caret, a way's light, the pen. */
  accent: string;
  /** The page's main button and its words. */
  button: string;
  buttonText: string;
  /** Tiles drifting behind the name, and the tab cards' paper. */
  tile: string;
  /** Flat surfaces (Android's in place of glass) and their hairline. */
  plate: string;
  hairline: string;
}

const coral = "#E8613C";

export const PALETTE: Record<"light" | "dark", FirstRunColors> = {
  light: {
    ground: "#F4F0E8",
    groundTop: "#F7E6DC",
    glow: coral,
    dot: "rgba(28,27,25,0.06)",
    ink: "#1C1B19",
    words: "#4A4741",
    faint: "rgba(28,27,25,0.32)",
    accent: coral,
    button: "#1C1B19",
    buttonText: "#F4F0E8",
    tile: "#FFFFFF",
    plate: "rgba(255,255,255,0.86)",
    hairline: "rgba(28,27,25,0.10)",
  },
  dark: {
    ground: "#121216",
    groundTop: "#1C1A2A",
    glow: "#6A5A9A",
    dot: "rgba(243,242,239,0.045)",
    ink: "#F3F2EF",
    words: "#D1CDC6",
    faint: "rgba(243,242,239,0.32)",
    accent: "#F0784F",
    button: "#F3F2EF",
    buttonText: "#121216",
    tile: "rgba(255,255,255,0.12)",
    plate: "rgba(38,37,44,0.9)",
    hairline: "rgba(243,242,239,0.10)",
  },
};

/** Private's night: the ground once the glasses are on. */
export const NIGHT = "#060608";

/** The green of a check and of a link's app. */
export const GREEN = "#34C759";

/** The first run's colours for the phone's light or dark mode. */
export function useFirstRunColors(): FirstRunColors {
  return PALETTE[useColorScheme() === "dark" ? "dark" : "light"];
}
