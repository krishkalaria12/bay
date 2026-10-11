import type { SpaceColor } from "../store/types";

// Each preset space colour's swatch, apart from the rest of its spec (lib/theme.ts SPACE_COLORS): the store picks a new
// space's look from them without importing the theme, which imports the store.
export const SPACE_SWATCHES: Record<SpaceColor, string> = {
  blue: "#4691C3",
  purple: "#7873AF",
  pink: "#D37B8B",
  red: "#C1575C",
  orange: "#D87249",
  yellow: "#E3AC38",
  green: "#3EB489",
  plum: "#C07A98",
  neutral: "#8E8E93",
};
