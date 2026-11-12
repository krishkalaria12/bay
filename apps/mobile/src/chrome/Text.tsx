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

/** Every piece of text in Bay: one type scale and one font on both platforms. */
export function Text({ variant = "body", weight, tone = "default", color, style, ...rest }: TextProps): JSX.Element {
  const themed = useThemeColor(toneColor[tone]);

  return <NativeText {...rest} style={[fontFor(variant, weight), { color: color ?? themed }, style]} />;
}
