// Keep platform policy real while Node tests avoid loading React Native's native views.
import { capabilitiesFor } from "../../../packages/platform/src/capabilities.ts";
import { relabelShortcuts, windowsShortcutLabel } from "../../../packages/platform/src/keys.ts";
export * from "../../../packages/platform/src/keys.ts";

export const platformOS = process.env.BAY_TEST_PLATFORM ?? "macos";
export const isMac = platformOS === "macos";
export const isWindows = platformOS === "windows";
export const batchedUpdates = (update) => update();
export const hasNativeModule = () => true;
export const capabilities = {
  ...capabilitiesFor(platformOS, hasNativeModule),
  ...(process.env.BAY_TEST_GLOBAL_COORDINATES !== undefined ? { globalWindowCoordinates: process.env.BAY_TEST_GLOBAL_COORDINATES === "true" } : {}),
};
export const modKey = (event) => !!(isMac ? event.metaKey : event.ctrlKey);
export const shortcutLabel = (hint) => relabelShortcuts(hint, platformOS);
export const shortcutForCommand = (command, macHint = "") => (isMac ? macHint : (windowsShortcutLabel(command) ?? shortcutLabel(macHint)));
export const platformKeyEvents = (events) => events.map((event) => (isMac || !event.metaKey ? { ...event } : { ...event, metaKey: false, ctrlKey: true }));
