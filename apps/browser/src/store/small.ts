import type { BrowserState } from "./browser";
import type { DeepReadonly } from "../runtime/projection";
import type { BrowserWindow } from "./types";

// Little Bay, our Little Arc: a small window with one page and no sidebar. Links from other apps open there
// (settings.openLinksInLittleBay), ⌘O moves the page into a main window, and closing it throws the page away
// (it stays in history, and ⇧⌘T brings it back in Little Bay).

export const isSmallWindow = (w: Pick<BrowserWindow, "kind"> | undefined): boolean => w?.kind === "small";

type ReadonlyWindows = Pick<BrowserState, "windows"> | Pick<DeepReadonly<Pick<BrowserState, "windows">>, "windows">;

export const isSmall = (s: ReadonlyWindows, windowId?: string | null): boolean => !!windowId && s.windows[windowId]?.kind === "small";

const isMain = (
  w: Pick<BrowserWindow, "incognito" | "kind" | "spaceId"> | DeepReadonly<Pick<BrowserWindow, "incognito" | "kind" | "spaceId">> | undefined,
): boolean => !!w && !w.incognito && w.kind !== "small";

// Where a Little Bay page goes: the frontmost main window showing its profile, else the frontmost main window.
type ReadonlySmallState = DeepReadonly<Pick<BrowserState, "windows" | "windowOrder" | "ui" | "settings">>;

export function mainWindowFor(s: BrowserState, spaceId?: string): string | undefined;
export function mainWindowFor(s: ReadonlySmallState, spaceId?: string): string | undefined;
export function mainWindowFor(s: BrowserState | ReadonlySmallState, spaceId?: string): string | undefined {
  const order = [...new Set([...s.ui.focusOrder, ...s.windowOrder])].filter((id) => isMain(s.windows[id]));
  return (spaceId ? order.find((id) => s.windows[id]!.spaceId === spaceId) : undefined) ?? order[0];
}

// A new Little Bay uses the profile the frontmost main window shows, else the default profile.
export function littleBayProfile(s: BrowserState | ReadonlySmallState): string {
  const main = mainWindowFor(s);
  return main ? s.windows[main]!.spaceId : s.settings.defaultSpaceId;
}

// Utility windows, Little Bay and private windows never change the most recent regular Space.
export function mostRecentSpace(s: BrowserState | ReadonlySmallState): string {
  const main = mainWindowFor(s);
  return main ? s.windows[main]!.spaceId : s.settings.defaultSpaceId;
}
