import type { IconName } from "@/chrome/Icon.types";

/**
 * How a glass object reads: `clear` lets what's behind show (the field, the desktop link), `solid` hides it (a tab card
 * in front of others, the last page's field) and `night` is the private page with the glasses on.
 */
export type GlassTone = "clear" | "solid" | "night";

/** A backdrop that fills its parent: Liquid Glass on iOS, a flat translucent surface with a hairline on Android. */
export interface BackdropProps {
  radius: number;
  tone: GlassTone;
}

/** The round ‹ in the welcome's top bar. */
export interface BackButtonProps {
  testID: string;
  label: string;
  icon: IconName;
  visible: boolean;
  onPress: () => void;
}

/** Skip, the capsule in the welcome's top bar. */
export interface SkipButtonProps {
  testID: string;
  label: string;
  visible: boolean;
  onPress: () => void;
}

/** The welcome's name, its letters in glass (iOS) or a flat translucent fill (Android), fitted to the given size. */
export interface NameProps {
  text: string;
  width: number;
  height: number;
}
