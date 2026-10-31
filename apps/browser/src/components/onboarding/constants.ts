import type { IntroMusicCues } from "@bay/shell";
import { APP_NAME } from "../../lib/constants";
import { tensionSpring } from "../../lib/springs";

// Onboarding's constants: the intro's timeline, the steps' card, and the tool tour.

// MARK: Intro (Intro.tsx)

// How long, in seconds, a letter takes to come in, then the tagline, then the exit.
export const INTRO_LETTER = 0.52;
export const INTRO_TAGLINE = 0.6;
export const INTRO_EXIT = 0.65;
// When the music's cues fall, in seconds from the start: the icon, the wordmark's letters, the tagline, the exit.
export const INTRO_CUES: IntroMusicCues = (() => {
  const icon = 0.25;
  const letters = 1.15;
  const letterStep = 0.055;
  const letterCount = APP_NAME.length;
  const tagline = letters + (letterCount - 1) * letterStep + INTRO_LETTER + 0.15;
  const exit = tagline + INTRO_TAGLINE + 1.1;
  return { icon, letters, letterStep, letterCount, tagline, exit, end: exit + INTRO_EXIT };
})();
// Animated's old spring: tension 50, friction 7.
export const INTRO_ICON_SPRING = tensionSpring(50, 7);

// MARK: Steps (OnboardingOverlay.tsx, state.ts)

export const ONBOARDING_CARD = { width: 880, height: 560, margin: 40 };
export const ONBOARDING_DOC = "onboarding.json";

// MARK: Import handoff (importStep.tsx)

// The browser you're leaving gets its own colours, [top right, bottom left]; Bay's half is its icon's night sky.
export const HANDOFF_COLORS: Record<string, [string, string]> = {
  arc: ["#F2507B", "#2A1FD0"],
  dia: ["#F55FD0", "#2F5BF2"],
  chrome: ["#4C8DF6", "#1648B8"],
  chromeBeta: ["#4C8DF6", "#1648B8"],
  chromeDev: ["#4C8DF6", "#1648B8"],
  chromeCanary: ["#F2A93B", "#C2541B"],
  chromium: ["#6AA0F8", "#2E57B5"],
  safari: ["#27A7F8", "#1446C2"],
  firefox: ["#FF9640", "#8A3FE8"],
  zen: ["#F98B6E", "#6A2C5A"],
  edge: ["#3CCB7F", "#0D5FB8"],
  brave: ["#FF6A3D", "#B5195A"],
  helium: ["#8C9AB3", "#2C3446"],
  opera: ["#FF4B55", "#9E0A1E"],
  operaGX: ["#FA1E4E", "#2A0F38"],
  vivaldi: ["#F25757", "#8E1F2A"],
  island: ["#4F86FF", "#14306E"],
};
export const HANDOFF_FALLBACK_COLORS: [string, string] = ["#7A78F0", "#2B2A63"];
export const BAY_SKY = "#2A2C4B";
export const BAY_GLOW = "#E8714A";
export const HANDOFF_ICON = 84;
// The tear between the halves: diamonds of Bay's sky biting into the other side.
export const HANDOFF_TOOTH = 8;
// How close the dragged icon's centre has to come to Bay's for it to take it.
export const HANDOFF_DROP_RADIUS = 76;
// How far the dotted path, and the icon sent along it with Return, dips between the two.
export const HANDOFF_DIP = 26;
export const HANDOFF_DOTS = 15;
// Animated's old spring: tension 120, friction 8.
export const HANDOFF_SPRING = tensionSpring(120, 8);

// MARK: Tool tour (tour/ToolTour.tsx)

export const TOUR_CARD_WIDTH = 296;
export const TOUR_GAP = 14;
export const TOUR_MARGIN = 12;
export const TOUR_SCRIM_REACH = 6000;
// Animated's old spring: tension 70, friction 10.
export const TOUR_SPOT_SPRING = tensionSpring(70, 10);
