import { getAppIconName, setAlternateAppIcon, supportsAlternateIcons } from "expo-alternate-app-icons";
import type { ImageSourcePropType } from "react-native";

import type { MessageKey } from "@/i18n";

/**
 * The icons Bay can wear on the home screen, the same set as the desktop's (Settings › Appearance there too).
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

export const canChangeAppIcon = supportsAlternateIcons;

/** The icon on the home screen now; an alternate this build doesn't know reads as the default. */
export function currentAppIcon(): AppIconChoice {
  const name = getAppIconName();

  return APP_ICONS.find((icon) => icon.name === name) ?? APP_ICONS[0]!;
}

/** Puts `icon` on the home screen. iOS confirms with its own alert; Android swaps the launcher entry. */
export async function setAppIcon(icon: AppIconChoice): Promise<void> {
  await setAlternateAppIcon(icon.name);
}
