import { Host, Image } from "@expo/ui/swift-ui";
import { font, foregroundStyle } from "@expo/ui/swift-ui/modifiers";
import type { ComponentProps, JSX } from "react";

import type { IconName, IconProps } from "./Icon.types";

const symbols: Record<IconName, NonNullable<ComponentProps<typeof Image>["systemName"]>> = {
  archive: "archivebox",
  search: "magnifyingglass",
  settings: "gearshape",
  tabs: "square.on.square",
  more: "ellipsis",
  fill: "arrow.up.left",
  close: "xmark",
  add: "plus",
  private: "eyeglasses",
  lock: "lock",
  shield: "shield",
  up: "chevron.up",
  down: "chevron.down",
  play: "play.fill",
  pause: "pause.fill",
};

// An SF Symbol inside React Native layout. The host ignores touches so the surrounding Pressable gets them.
export function Icon({ name, color, size = 24 }: IconProps): JSX.Element {
  return (
    <Host matchContents pointerEvents="none">
      <Image systemName={symbols[name]} modifiers={[font({ size: size * 0.75 }), foregroundStyle(color)]} />
    </Host>
  );
}
