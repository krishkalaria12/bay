import { Host, Image } from "@expo/ui/swift-ui";
import { accessibilityHidden, font, foregroundStyle } from "@expo/ui/swift-ui/modifiers";
import type { ComponentProps, JSX } from "react";
import { View } from "react-native";

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
  tick: "checkmark",
};

// An SF Symbol inside React Native layout. The host ignores touches so the surrounding Pressable gets them, and
// VoiceOver skips it: the control around it carries the label, and SwiftUI would otherwise read the symbol's name.
// Every symbol sits centred in the same size × size square, like Android's Material Symbols: a symbol's own width varies
// (a pin is narrower than a gear), and sized to that, the text beside each icon started somewhere else.
export function Icon({ name, color, size = 24 }: IconProps): JSX.Element {
  return (
    <View pointerEvents="none" style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Host matchContents pointerEvents="none">
        <Image systemName={symbols[name]} modifiers={[font({ size: size * 0.75 }), foregroundStyle(color), accessibilityHidden(true)]} />
      </Host>
    </View>
  );
}
