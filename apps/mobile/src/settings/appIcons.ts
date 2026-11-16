import { useState } from "react";
import type { ImageSourcePropType } from "react-native";

import type { MessageKey } from "@/i18n";

/**
 * The icons Bay can wear on the home screen, the same set as the desktop's (Settings › Appearance › App icon here, Settings › Appearance there).
 * `name` is the alternate's name in app.json (null is the bundle's own icon, Dusk in Paper); the images are the
 * full-bleed iOS icons scripts/make-icon.sh renders, shown in the picker.
 */
export interface AppIconChoice {
  name: string | null;
  label: MessageKey;
  image: ImageSourcePropType;
}

export const APP_ICONS: readonly AppIconChoice[] = [
  { name: null, label: "settings.appIcons.paper", image: require("../../assets/images/icon.png") },
  { name: "Navy", label: "settings.appIcons.navy", image: require("../../assets/images/app-icons/navy.png") },
  { name: "Coral", label: "settings.appIcons.coral", image: require("../../assets/images/app-icons/coral.png") },
  { name: "Noir", label: "settings.appIcons.noir", image: require("../../assets/images/app-icons/noir.png") },
  { name: "Cobalt", label: "settings.appIcons.cobalt", image: require("../../assets/images/app-icons/cobalt.png") },
  { name: "Bridge", label: "settings.appIcons.bridge", image: require("../../assets/images/app-icons/bridge.png") },
];

type AlternateIcons = typeof import("expo-alternate-app-icons");

/**
 * The native module, required when first used and null where this build hasn't got it (a dev client built before it
 * was added), so Settings still opens without the picker instead of the app failing to start.
 */
const alternateIcons = ((): AlternateIcons | null => {
  try {
    // SAFETY: the require names the module its type is taken from.
    return require("expo-alternate-app-icons") as AlternateIcons;
  } catch {
    return null;
  }
})();

export const canChangeAppIcon = alternateIcons?.supportsAlternateIcons ?? false;

/** The icon on the home screen now; an alternate this build doesn't know reads as the default. */
export function currentAppIcon(): AppIconChoice {
  const name = alternateIcons?.getAppIconName() ?? null;

  return APP_ICONS.find((icon) => icon.name === name) ?? APP_ICONS[0]!;
}

/** Puts `icon` on the home screen. iOS confirms with its own alert; Android swaps the launcher entry. */
export async function setAppIcon(icon: AppIconChoice): Promise<void> {
  await alternateIcons?.setAlternateAppIcon(icon.name);
}

/** The home screen icon and a way to change it, or null where the phone can't. */
export interface AppIconState {
  current: AppIconChoice;
  choose: (icon: AppIconChoice) => void;
}

export function useAppIcon(): AppIconState | null {
  const [current, setCurrent] = useState<AppIconChoice>(() => (canChangeAppIcon ? currentAppIcon() : APP_ICONS[0]!));

  if (!canChangeAppIcon) return null;

  return {
    current,
    choose: (icon) => {
      if (icon === current) return;
      const before = current;

      setCurrent(icon);
      // iOS can refuse (the app in the background, another change still going): show the icon that stayed.
      setAppIcon(icon).catch(() => setCurrent(before));
    },
  };
}
