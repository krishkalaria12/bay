// What sync needs from the phone itself: secure random bytes for keys and codes, the name the other devices list it
// by, and the words for the computer's bookmarks bar. The native modules are required when first used, not imported:
// Node's tests load the runtime, and these modules don't load there.
import { t } from "../i18n/index.ts";
import type { SyncPlatform } from "./service.ts";

// SAFETY: each require names the module its type is taken from.
const crypto = () => require("expo-crypto") as typeof import("expo-crypto");
// SAFETY: as above.

const device = () => require("expo-device") as typeof import("expo-device");
// SAFETY: as above.

const os = () => (require("react-native") as typeof import("react-native")).Platform.OS;

export const syncPlatform: SyncPlatform = {
  random: (length) => crypto().getRandomBytes(length),
  // Android has the name the person gave the phone; iOS gives apps only "iPhone", so its model says more.
  deviceName: () => {
    const { deviceName, modelName } = device();
    const ios = os() === "ios";

    return (ios ? (modelName ?? deviceName) : (deviceName ?? modelName)) ?? (ios ? "iPhone" : "Android");
  },
  barTitle: () => t("sync.bar"),
};
