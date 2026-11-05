import type { JSX } from "react";

import type { IconProps } from "./Icon.types";
import { MaterialSymbol } from "./MaterialSymbol";

export function Icon({ name, color, size = 24 }: IconProps): JSX.Element {
  return <MaterialSymbol name={name} color={color} size={size} />;
}
