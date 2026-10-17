import { requireOptionalNativeModule } from "./native";
import { capabilitiesFor } from "./capabilities";
export const platformOS = "windows" as const;
export const isMac = false;
export const isWindows = true;
export function hasNativeModule(name: string): boolean {
  return requireOptionalNativeModule(name) != null;
}
export const capabilities = capabilitiesFor(platformOS, hasNativeModule);
