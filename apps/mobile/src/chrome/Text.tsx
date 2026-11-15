import { useThemeColor } from "heroui-native";
import type { JSX } from "react";
import { Text as NativeText, type TextProps as NativeTextProps } from "react-native";

import { fontFor, type TextVariant, type TextWeight } from "./tokens";

/** What the text is for, which picks its colour from the theme. */
export type TextTone = "default" | "muted" | "accent" | "danger";

export interface TextProps extends NativeTextProps {
  /** A step of the type scale (`tokens.ts`). */
  variant?: TextVariant;
  /** Another weight than the step's own. */
  weight?: TextWeight;
  tone?: TextTone;
  /** A colour the theme doesn't have, such as text over a private (always dark) surface. Wins over `tone`. */
  color?: string;
}

const toneColor = { default: "foreground", muted: "muted", accent: "accent", danger: "danger" } as const;

/**
 * How far each step follows the phone's text size (C15). Reading text follows it a long way; the labels that sit in
 * fixed shapes (tiles, the bar, chips) stop before they spill out of them.
 */
const MAX_SCALE: Record<TextVariant, number> = {
  display: 1.3,
  title: 1.5,
  headline: 1.8,
  body: 2,
  callout: 2,
  subhead: 1.8,
  footnote: 1.6,
  caption: 1.4,
  micro: 1.3,
};

/** Every piece of text in Bay: one type scale and one font on both platforms. */
export function Text({ variant = "body", weight, tone = "default", color, style, ...rest }: TextProps): JSX.Element {
  const themed = useThemeColor(toneColor[tone]);

  return <NativeText maxFontSizeMultiplier={MAX_SCALE[variant]} {...rest} style={[fontFor(variant, weight), { color: color ?? themed }, style]} />;
}
