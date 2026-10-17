import { tensionSpring } from "../../lib/springs";

// The new tab page's constants: its banners and cards, and the release notes' postcard.

// MARK: Banners (CheckInBanner.tsx, TelemetryAsk.tsx)

export const CHECK_IN_FRAME = { width: 282, height: 69 };
export const TELEMETRY_ASK_FRAME = { width: 300 };

// MARK: Personalize (Personalize.tsx)

export const PERSONALIZE_INSET = 16;
export const PERSONALIZE_BUTTON = 30;
// The palette glyph is wider than tall: drop the button so its visible gaps to the right and bottom edges match.
export const GLYPH_DROP = 1.5;
// Animated's old spring: tension 90, friction 9.
export const PERSONALIZE_SPRING = tensionSpring(90, 9);

// MARK: Postcard (Postcard.tsx, releaseNotes.ts)

export const POSTCARD = { width: 320, height: 200, overhangRight: 40, overhangTop: 30, tilt: 2, radius: 10 };
export const POSTCARD_HOVER_SLOP = 24;
export const POSTCARD_TOOLTIP = { height: 28, gap: 4 };
export const POSTCARD_PAPER = "#FCFCFA";
export const POSTCARD_INK = "#1D1B1A";
// Animated's old spring: tension 55, friction 9.
export const POSTCARD_PAGE_SPRING = tensionSpring(55, 9);
export const POSTCARD_SECONDS = 86_400;
export const RELEASE_NOTES_DOC = "release-notes.json";
