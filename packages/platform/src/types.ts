/** Bay ships desktop applications for macOS and Windows. */
export type PlatformOS = "macos" | "windows";
export const isAppleOS = (os: PlatformOS): boolean => os === "macos";
export const isDesktopOS = (_os: PlatformOS): boolean => true;
