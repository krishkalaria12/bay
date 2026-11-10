import type { JSX } from "react";
import { View } from "react-native";

import type { SurfaceProps } from "./Surface.types";

// Arc Search's Android surfaces: a translucent fill and a hairline edge, no elevation and no blur.
export function Surface({ radius, children, style, testID }: SurfaceProps): JSX.Element {
  return (
    <View testID={testID} className="border border-black/10 bg-white/90 dark:border-white/10 dark:bg-neutral-900/90" style={[{ borderRadius: radius }, style]}>
      {children}
    </View>
  );
}
