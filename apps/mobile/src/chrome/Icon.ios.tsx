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
  back: "chevron.backward",
  forward: "chevron.forward",
  reload: "arrow.clockwise",
  reader: "doc.plaintext",
  find: "doc.text.magnifyingglass",
  inspect: "chevron.left.forwardslash.chevron.right",
  hide: "eye.slash",
  markdown: "text.alignleft",
  share: "square.and.arrow.up",
  pin: "pin",
  unpin: "pin.slash",
  link: "link",
  copy: "doc.on.doc",
  history: "clock.arrow.circlepath",
  delete: "trash",
  desktop: "desktopcomputer",
  offline: "wifi.slash",
  error: "exclamationmark.circle",
  chevron: "chevron.forward",
  wallpaper: "photo.on.rectangle",
  download: "arrow.down.circle",
  check: "checkmark.circle",
  translate: "translate",
  mic: "mic",
  pip: "rectangle.inset.bottomright.filled",
  textSize: "textformat.size",
  palette: "paintpalette",
  tune: "slider.horizontal.3",
  visibility: "eye",
};

// An SF Symbol inside React Native layout. The host ignores touches so the surrounding Pressable gets them.
export function Icon({ name, color, size = 24 }: IconProps): JSX.Element {
  return (
    <Host matchContents pointerEvents="none">
      <Image systemName={symbols[name]} modifiers={[font({ size: size * 0.75 }), foregroundStyle(color)]} />
    </Host>
  );
}
