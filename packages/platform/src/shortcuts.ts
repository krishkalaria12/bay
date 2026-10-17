import { platformOS } from "./os";
import { relabelShortcuts, windowsShortcutLabel } from "./keys";

export type KeyModifiers = { metaKey?: boolean; ctrlKey?: boolean };
export const modKey = (event: KeyModifiers): boolean => !!(platformOS === "macos" ? event.metaKey : event.ctrlKey);
export const shortcutLabel = (hint: string): string => relabelShortcuts(hint, platformOS);
export const shortcutForCommand = (command: string, macHint = ""): string =>
  platformOS === "macos" ? macHint : windowsShortcutLabel(command) ?? shortcutLabel(macHint);

/** Translate the macOS command-key event table before handing it to RNW. */
export function platformKeyEvents<T extends KeyModifiers>(events: readonly T[]): T[] {
  return events.map((event) => platformOS === "macos" || !event.metaKey
    ? { ...event }
    : { ...event, metaKey: false, ctrlKey: true });
}
