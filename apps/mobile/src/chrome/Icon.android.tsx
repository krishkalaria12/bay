import type { JSX } from "react";

import type { IconProps } from "./Icon.types";
import { MaterialSymbol } from "./MaterialSymbol";

// Decorative, like the iOS one: MaterialSymbol keeps TalkBack off the drawing.
export function Icon({ name, color, size = 24 }: IconProps): JSX.Element {
  return <MaterialSymbol name={name} color={color} size={size} />;
}
