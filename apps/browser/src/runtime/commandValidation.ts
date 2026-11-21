import * as v from "valibot";
import type { JsonInput, JsonObject } from "../lib/json";
import type { BrowserState } from "../store/browserStore";
import { isIncognitoSpace, tabListKey } from "../store/model";

export class BrowserCommandError extends Error {
  readonly code = "invalid_request";
  constructor(message: string) {
    super(message);
    this.name = "BrowserCommandError";
  }
}

export const invalidCommand: (message: string) => never = (message) => {
  throw new BrowserCommandError(message);
};

/** A command payload is parsed JSON: a plain object of named fields. */
const isCommandObject = (value: unknown): value is JsonObject =>
  v.is(v.object({}), value) && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/**
 * Reads a command payload as a plain JSON object, optionally limited to named
 * fields. The payload is checked here, at the boundary, so a caller may hand
 * over whatever it received.
 */
export function commandObject<T>(value: T, fields?: readonly string[]): JsonObject {
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- The table is a lookup by name, so its open shape is the point.
  if (!isCommandObject(value)) return invalidCommand("expected a command object");

  if (fields && Object.keys(value).some((key) => !fields.includes(key))) return invalidCommand("unexpected command field");

  return value;
}

export function commandText(value: JsonInput, limit = 1024, empty = false): string {
  if (!v.is(v.string(), value) || (!empty && !value.trim()) || value.length > limit) return invalidCommand("invalid command text");

  return value;
}

export const commandUrl = (value: JsonInput) => commandText(value, 1_048_576, true);

export function commandBoolean(value: JsonInput): boolean {
  return v.is(v.boolean(), value) ? value : invalidCommand("invalid command boolean");
}

export function commandIndex<T>(value: T, minimum = 0): number {
  if (!v.is(v.number(), value) || !Number.isSafeInteger(value) || value < minimum || value > 1_000_000) return invalidCommand("invalid command index");

  return value;
}

export function commandTimestamp(value: JsonInput): number {
  if (!v.is(v.number(), value) || !Number.isSafeInteger(value) || value < 0) return invalidCommand("invalid command time");

  return value;
}

export function commandIds(value: JsonInput): string[] {
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

export type CommandReaders<T> = { [K in keyof T]-?: (value: JsonInput) => T[K] };

/** Reads only the present fields; `undefined` never reaches a reducer patch. */
export function commandFields<T>(o: JsonObject, readers: CommandReaders<T>): T {
  const out: Record<string, T[keyof T]> = {};
  // SAFETY: the readers own their keys, so the cast names the fields `T` declares.
  const keys = Object.keys(readers) as (keyof T & string)[];

  for (const key of keys) {
    const value = o[key];

    if (value !== undefined) out[key] = readers[key](value);
  }

  // SAFETY: every key of `T` was read by its own reader, so `out` holds exactly those fields.
  return out as T;
}

/** A name or icon the user may clear (null) or leave empty. */
export const commandNullableText = (value: JsonInput): string | null => (value === null ? null : commandText(value, 1024, true));

export function commandOptionalText(value: JsonInput): string | null {
  return value === null ? null : commandText(value);
}

/** Several tabs in one command never mix private and public pages, or two private windows. */
export function requireCommandTabs(s: BrowserState, ids: readonly string[]) {
  const tabs = ids.map((id) => requireCommandTab(s, id));
  const context = (spaceId: string) => (isIncognitoSpace(spaceId) ? spaceId : "");

  if (tabs.some((tab) => context(tab.spaceId) !== context(tabs[0]!.spaceId))) return invalidCommand("tabs cross private window boundaries");

  return tabs;
}

export function requireCommandGroup(s: BrowserState, id: string) {
  const group = Object.hasOwn(s.groups, id) ? s.groups[id] : undefined;

  if (!group || group.id !== id) return invalidCommand("group no longer exists");

  if (isIncognitoSpace(group.spaceId)) {
    if (!Object.values(s.windows).some((w) => w.incognito && w.spaceId === group.spaceId)) return invalidCommand("group no longer exists");
  } else requireCommandSpace(s, group.spaceId);

  return group;
}

export function requireCommandFolder(s: BrowserState, id: string) {
  const folder = Object.hasOwn(s.pinnedFolders, id) ? s.pinnedFolders[id] : undefined;

  if (!folder || folder.id !== id) return invalidCommand("folder no longer exists");
  requireCommandSpace(s, folder.spaceId);

  return folder;
}

export function requireCommandSplit(s: BrowserState, id: string) {
  const split = Object.hasOwn(s.splits, id) ? s.splits[id] : undefined;

  if (!split || split.id !== id) return invalidCommand("split no longer exists");
  requireCommandTabs(s, split.tabIds);

  return split;
}
