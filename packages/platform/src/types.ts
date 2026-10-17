/** Bay supports desktop hosts only. Windows and Linux share the WebUI renderer. */
export type PlatformOS = "macos" | "windows" | "linux";
export const isAppleOS = (os: PlatformOS): boolean => os === "macos";
export const isDesktopOS = (_os: PlatformOS): boolean => true;
