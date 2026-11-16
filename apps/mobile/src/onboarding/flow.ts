// The first run's way through, without the screen: which page comes after which, what the dots count, and the
// demonstrations' numbers. Ported from Yab's first run (Phone/Sources/Welcome/FirstRun.swift, Apache-2.0), with Bay's
// pages: a desktop page in place of Yab's Mac sync, and the field's three ways being Bay's own.

import { springConfig, type Spring } from "../chrome/layout.ts";

/** A page of the first run. `end` is the moment the glass becomes the real field and the welcome goes. */
export type Step = "welcome" | "desktop" | "field" | "private" | "links" | "end";

/** The pages the dots count: the welcome, the desktop, the field, private and, while Bay may ask to be it, links. */
export function pageCount(asksLinks: boolean): number {
  return asksLinks ? 5 : 4;
}

/** The dot of the page on screen. */
export function pageOf(step: Step, asksLinks: boolean): number {
  switch (step) {
    case "welcome":
      return 0;
    case "desktop":
      return 1;
    case "field":
      return 2;
    case "private":
      return 3;
    case "links":
    case "end":
      return Math.min(4, pageCount(asksLinks) - 1);
  }
}

/** The page the main button goes on to, or `finish` when it ends the welcome. Links ends it with its own question. */
export function forward(step: Step, asksLinks: boolean): Step | "finish" {
  switch (step) {
    case "welcome":
      return "desktop";
    case "desktop":
      return "field";
    case "field":
      return "private";
    case "private":
      return asksLinks ? "links" : "finish";
    case "links":
    case "end":
      return "finish";
  }
}

/** The page ‹ goes back to, or null where there's no going back. */
export function back(step: Step): Step | null {
  switch (step) {
    case "welcome":
    case "end":
      return null;
    case "desktop":
      return "welcome";
    case "field":
      return "desktop";
    case "private":
      return "field";
    case "links":
      return "private";
  }
}

/**
 * Skip opens the real field, unless the person is already past it: from the private page or the links page, it just
 * shows the browser underneath.
 */
export function skipOpensField(step: Step): boolean {
  return step !== "private" && step !== "links";
}

/** Whether Bay asks to be the default browser: only where it can be, and isn't yet. */
export function asksAboutLinks(status: "default" | "not" | "unknown" | "unavailable"): boolean {
  return status === "not" || status === "unknown";
}

/** The field page's three ways: Search, Go to site, Your tabs. */
export type Way = 0 | 1 | 2;

/**
 * What the field types and the way each lands in, as string keys: the typed words, and for Your tabs the open tab it
 * finds. The words are the reader's language, so they live with the other strings.
 */
export const PHRASES = [
  { typed: "welcome.phrase.weather", way: 0, landed: "welcome.phrase.weather" },
  { typed: "welcome.phrase.site", way: 1, landed: "welcome.phrase.site" },
  { typed: "welcome.phrase.flights", way: 2, landed: "welcome.phrase.flightsTab" },
  { typed: "welcome.phrase.recipe", way: 0, landed: "welcome.phrase.recipe" },
  { typed: "welcome.phrase.news", way: 1, landed: "welcome.phrase.news" },
  { typed: "welcome.phrase.soup", way: 2, landed: "welcome.phrase.soupTab" },
] as const;

/** A link from another app on the links page: where it goes, the tab it becomes, and its page's colours. */
export const LINKS = [
  { host: "timeout.com", title: "welcome.link.things", from: "messages", colors: ["#F7C873", "#EE7B5B", "#B5527A"] },
  { host: "airbnb.com", title: "welcome.link.stay", from: "mail", colors: ["#FF9A8B", "#E0565B"] },
  { host: "flytap.com", title: "welcome.link.flight", from: "messages", colors: ["#86D9A4", "#2E9E6B"] },
] as const;

/** Sites drifting behind the name on the first page. */
export const DRIFT_SITES = [
  "news.ycombinator.com",
  "wikipedia.org",
  "airbnb.com",
  "github.com",
  "are.na",
  "nytimes.com",
  "theverge.com",
  "youtube.com",
  "notion.so",
  "figma.com",
  "flytap.com",
] as const;

// Motion: the prototype's numbers, as SwiftUI springs.
const springs = {
  /** The glass from one page's shape into the next. */
  morph: { response: 0.5, dampingRatio: 0.86 },
  /** A typed phrase into its way. */
  land: { response: 0.42, dampingRatio: 0.82 },
  /** The dots, and the keyboard lifting the words. */
  dots: { response: 0.36, dampingRatio: 0.86 },
  /** A link growing into the tab in front. */
  link: { response: 0.42, dampingRatio: 0.8 },
  /** Private's chips springing in. */
  chips: { response: 0.45, dampingRatio: 0.7 },
} satisfies Record<string, Spring>;

export const MORPH = springConfig(springs.morph);
export const LAND = springConfig(springs.land);
export const DOTS = springConfig(springs.dots);
export const LINK = springConfig(springs.link);
export const CHIPS = springConfig(springs.chips);

/** The drawing above the words, in its own units: 402 wide, as the prototype draws it, scaled to the screen. */
export const STAGE = { width: 402, height: 560 } as const;

/** A rect on the stage. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the name's letters sit: the next page's glass grows out of them. */
export const LETTERS: Rect = { x: 34, y: 122, width: 334, height: 137 };

/** How tall each page's drawing is, for scaling it into the room above the words. */
export function stageNeeds(step: Step): number {
  switch (step) {
    case "welcome":
      return 348;
    case "desktop":
      return 392;
    case "field":
      return 356;
    case "private":
      return 320;
    case "links":
      return 352;
    case "end":
      return 220;
  }
}

/** The glass object's place and corner on each page. */
export function hero(step: Step): Rect & { radius: number } {
  switch (step) {
    case "welcome":
      return { ...LETTERS, radius: 40 };
    case "desktop":
      return { x: 36, y: 322, width: 330, height: 68, radius: 34 };
    case "field":
      return { x: 20, y: 84, width: 362, height: 60, radius: 30 };
    case "private":
      return { x: 20, y: 160, width: 362, height: 56, radius: 28 };
    case "links":
      return { x: 86, y: 48, width: 230, height: 300, radius: 30 };
    case "end":
      return { x: 16, y: 120, width: 370, height: 48, radius: 24 };
  }
}

/** The stage's scale: as wide as the screen allows, and small enough to leave the words their room. */
export function stageScale(width: number, available: number, step: Step): number {
  return Math.max(0.45, Math.min(width / STAGE.width, 1.1, available / stageNeeds(step)));
}

/** Ease-out cubic, for counts and drawings that settle. */
export function easeOut(progress: number): number {
  const p = Math.min(Math.max(progress, 0), 1);

  return 1 - (1 - p) ** 3;
}
