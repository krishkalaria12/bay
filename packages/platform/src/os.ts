import { Platform } from "react-native";
import { requireOptionalNativeModule } from "./native";
import { capabilitiesFor } from "./capabilities";
import type { PlatformOS } from "./types";

if (Platform.OS !== "macos" && Platform.OS !== "windows") {
  throw new Error(`Bay supports desktop macOS and Windows, received ${Platform.OS}`);
}
export const platformOS = Platform.OS as PlatformOS;
export const isMac = platformOS === "macos";
export const isWindows = platformOS === "windows";
export function hasNativeModule(name: string): boolean {
  return requireOptionalNativeModule(name) != null;
}
export const capabilities = capabilitiesFor(platformOS, hasNativeModule);
