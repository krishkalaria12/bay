import { capabilitiesFor } from "./capabilities";
import { getNativeHostInfo } from "./nativeBridge";
import type { PlatformOS } from "./types";

// The trusted bootstrap installs host information before importing the React application.
// Platform.OS is "web" here, so it cannot identify the desktop that owns the window.
const host = getNativeHostInfo();
if (host.platform !== "windows" && host.platform !== "linux") {
  throw new Error(`Bay's web host requires desktop Windows or Linux, received ${host.platform}`);
}
export const platformOS: PlatformOS = host.platform;
export const isMac = false;
export const isWindows = platformOS === "windows";
export const hasNativeModule = (name: string): boolean => host.modules.includes(name);
export const capabilities = {
  ...capabilitiesFor(platformOS, hasNativeModule),
  tooltips: true,
  focusRing: true,
  keyDownEvents: true,
  nativeDrag: true,
  windowMoveByView: true,
};
