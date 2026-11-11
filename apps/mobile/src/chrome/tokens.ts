import { Platform, type TextStyle } from "react-native";

/**
 * Bay's design tokens: the one place type, corners, spacing and icon sizes are decided. Screens pick a step from these
 * scales instead of writing their own numbers, so a sheet, a tile and a row all read as one app on both platforms.
 */

/**
 * Corners. Nested shapes step down the scale, so an inner corner never looks rounder than the one around it: a sheet
 * (`sheet`) holds cards (`card`), cards hold tiles (`tile`), tiles hold small controls (`control`).
 */
export const radius = {
  /** Chips' inner pieces, thumbnails, the find bar's buttons. */
  control: 12,
  /** Menu tiles, pinned sites, suggestion rows. */
  tile: 18,
  /** Grouped rows, the search card's fields, toasts. */
  card: 22,
  /** Tab cards and the search card. */
  panel: 28,
  /** Sheets' top corners. */
  sheet: 32,
} as const;

/** Spacing on a 4pt grid. `gutter` is the distance from the screen's (or a sheet's) edge to its content. */
export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  gutter: 20,
} as const;

/** Icon sizes: inside text (`inline`), in rows (`row`), in bars and tiles (`control`). */
export const iconSize = {
  inline: 14,
  small: 18,
  row: 20,
  control: 22,
} as const;

/** The height of every tappable row, so lists line up wherever they appear. */
export const rowHeight = 52;

/** A step of the type scale (`typeScale`). */
export type TextVariant = "title" | "headline" | "body" | "callout" | "subhead" | "footnote" | "caption" | "micro";

/** The weights Bay's text comes in; Android has one Inter face for each. */
export type TextWeight = "regular" | "medium" | "semibold" | "bold";

interface Step {
  size: number;
  lineHeight: number;
  weight: TextWeight;
  /** Inter's tracking at this size, matched to how San Francisco tracks itself. iOS tracks the system font on its own. */
  tracking: number;
}

/**
 * The type scale, after iOS's text styles: every piece of text in Bay is one of these. Weights are the defaults for a
 * step; a `Text` can still ask for another.
 */
export const typeScale: Record<TextVariant, Step> = {
  /** Sheet titles. */
  title: { size: 22, lineHeight: 28, weight: "bold", tracking: -0.45 },
  /** A sheet's subject (the page's title), empty states. */
  headline: { size: 17, lineHeight: 22, weight: "semibold", tracking: -0.3 },
  /** Row labels and anything read as a sentence. */
  body: { size: 16, lineHeight: 21, weight: "regular", tracking: -0.25 },
  /** The search field, the bar's capsule, buttons. */
  callout: { size: 15, lineHeight: 20, weight: "regular", tracking: -0.2 },
  /** A row's value and its detail line. */
  subhead: { size: 14, lineHeight: 19, weight: "regular", tracking: -0.12 },
  /** Section labels, addresses, notes under a control. */
  footnote: { size: 13, lineHeight: 18, weight: "regular", tracking: -0.06 },
  /** Tile labels and captions under icons. */
  caption: { size: 12, lineHeight: 16, weight: "medium", tracking: 0 },
  /** Badges. */
  micro: { size: 11, lineHeight: 13, weight: "semibold", tracking: 0.05 },
};

const weights: Record<TextWeight, TextStyle["fontWeight"]> = { regular: "400", medium: "500", semibold: "600", bold: "700" };

/** Inter's static faces, loaded at start on Android (`useAppFonts`). */
export const androidFaces: Record<TextWeight, string> = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
};

/**
 * The font for a step of the scale: San Francisco on iOS, where the system controls (Liquid Glass buttons, menus) set
 * their text in it too, and Inter on Android, the closest match to it, so both apps read the same. Android picks a face
 * per weight, because it fakes bold from the regular face when only a weight is given.
 */
export function fontFor(variant: TextVariant, weight: TextWeight = typeScale[variant].weight): TextStyle {
  const step = typeScale[variant];

  return Platform.OS === "android"
    ? { fontFamily: androidFaces[weight], fontSize: step.size, lineHeight: step.lineHeight, letterSpacing: step.tracking, includeFontPadding: false }
    : { fontSize: step.size, lineHeight: step.lineHeight, fontWeight: weights[weight] };
}

/**
 * A text field's font: the step's face and size without its line height, which would push a single-line field's text
 * off centre on iOS.
 */
export function inputFont(variant: TextVariant = "body", weight?: TextWeight): TextStyle {
  const { lineHeight: _lineHeight, ...font } = fontFor(variant, weight);

  return font;
}
