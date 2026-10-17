// Keep platform policy real while Node tests avoid loading React Native's native views.
import { capabilitiesFor } from '../../../packages/platform/src/capabilities.ts';
import { relabelShortcuts, windowsShortcutLabel } from '../../../packages/platform/src/keys.ts';
export * from '../../../packages/platform/src/keys.ts';

export const platformOS = process.env.BAY_TEST_PLATFORM === 'windows' ? 'windows' : 'macos';
export const isMac = platformOS === 'macos';
export const isWindows = !isMac;
export const hasNativeModule = () => true;
export const capabilities = capabilitiesFor(platformOS, hasNativeModule);
export const modKey = (event) => !!(isMac ? event.metaKey : event.ctrlKey);
export const shortcutLabel = (hint) => relabelShortcuts(hint, platformOS);
export const shortcutForCommand = (command, macHint = '') => isMac ? macHint : windowsShortcutLabel(command) ?? shortcutLabel(macHint);
export const platformKeyEvents = (events) => events.map((event) => isMac || !event.metaKey ? { ...event } : { ...event, metaKey: false, ctrlKey: true });
