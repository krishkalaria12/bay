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

// MARK: Tool tour (tour/ToolTour.tsx)

export const TOUR_CARD_WIDTH = 296;
export const TOUR_GAP = 14;
export const TOUR_MARGIN = 12;
export const TOUR_SCRIM_REACH = 6000;
// Animated's old spring: tension 70, friction 10.
export const TOUR_SPOT_SPRING = tensionSpring(70, 10);
