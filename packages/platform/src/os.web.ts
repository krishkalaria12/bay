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
  // Linux must report the active Ozone backend, not infer it from the desktop environment.
  globalWindowCoordinates: isWindows || host.constants.BayShell?.globalWindowCoordinates === true,
  // Mica behind a transparent UI, when the host's frame draws it (Windows 11 22H2+); a solid window otherwise.
  windowBackdrop: host.constants.BayShell?.backdrop === "mica",
  tooltips: true,
  focusRing: true,
  keyDownEvents: true,
  nativeDrag: true,
  windowMoveByView: true,
};
