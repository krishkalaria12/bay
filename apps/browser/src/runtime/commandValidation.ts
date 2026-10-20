import type { BrowserState } from "../store/browser";
import { isIncognitoSpace, tabListKey } from "../store/model";

export class BrowserCommandError extends Error {
  readonly code = "invalid_request";
  constructor(message: string) {
    super(message);
    this.name = "BrowserCommandError";
  }
}
export const invalidCommand = (message: string): never => {
  throw new BrowserCommandError(message);
};
export function commandObject(value: unknown, fields?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    return invalidCommand("expected a command object");
  const object = value as Record<string, unknown>;
  if (fields && Object.keys(object).some((key) => !fields.includes(key))) return invalidCommand("unexpected command field");
  return object;
}
export function commandText(value: unknown, limit = 1024, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > limit) return invalidCommand("invalid command text");
  return value;
}
export const commandUrl = (value: unknown) => commandText(value, 1_048_576, true);
export function commandBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : invalidCommand("invalid command boolean");
}
export function commandIndex(value: unknown, minimum = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= 1_000_000 ? value : invalidCommand("invalid command index");
}
export function commandIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10_000) return invalidCommand("invalid command ids");
  const ids = Array.from(value, (id) => commandText(id));
  if (new Set(ids).size !== ids.length) return invalidCommand("duplicate command ids");
  return ids;
}
export function requireCommandWindow(s: BrowserState, id: string) {
  const window = Object.hasOwn(s.windows, id) ? s.windows[id] : undefined;
  if (!window || window.id !== id || (window.incognito ? window.spaceId !== `incognito:${id}` : !Object.hasOwn(s.spaces, window.spaceId)))
    return invalidCommand("window no longer exists");
  return window;
}
export function requireCommandSpace(s: BrowserState, id: string) {
  if (isIncognitoSpace(id) || !Object.hasOwn(s.spaces, id)) return invalidCommand("space no longer exists");
  return s.spaces[id]!;
}
export function requireCommandTab(s: BrowserState, id: string) {
  const tab = Object.hasOwn(s.tabs, id) ? s.tabs[id] : undefined;
  if (!tab || tab.id !== id || !s.tabLists[tabListKey(s, tab)]?.includes(id)) return invalidCommand("tab no longer exists");
  if (isIncognitoSpace(tab.spaceId)) {
    const owner = requireCommandWindow(s, tab.windowId);
    if (!owner.incognito || owner.spaceId !== tab.spaceId) return invalidCommand("tab does not belong to its private window");
  } else {
    requireCommandSpace(s, tab.spaceId);
    if (tab.windowId && requireCommandWindow(s, tab.windowId).incognito) return invalidCommand("tab does not belong to its window");
  }
  return tab;
}
