import type { AppEvent, WindowEvent } from "@bay/desktop";
import type { BrowserState } from "../../store/browserStore";
import { activeTabId } from "../../store/model";

// Little Bay windows left alone are put away, as Arc did with Little Arc (every six hours by default, its time in
// Settings › Links): the window closes and its page goes to the Library's archive, under Little Bay. One in front,
// or playing sound, stays.

const HOUR = 60 * 60_000;

/**
 * The Little Bay windows to put away: unused for `hours` (since they were last in front, or opened). `inUse`: the
 * window in front while Bay is the active app, which is never idle.
 */
export function littleBaysToPutAway(
  s: BrowserState,
  { now, hours, usedAt, inUse }: { now: number; hours: number | null; usedAt: (windowId: string) => number | undefined; inUse: string | null },
): string[] {
  if (hours === null || !(hours > 0)) return [];

  return Object.values(s.windows)
    .filter((w) => w.kind === "small" && w.id !== inUse)
    .filter((w) => {
      const tabId = activeTabId(s, w.id);

      return !(tabId && s.live[tabId]?.playingAudio);
    })
    .filter((w) => now - Math.max(usedAt(w.id) ?? 0, w.createdAt) >= hours * HOUR)
    .map((w) => w.id);
}

// When each Little Bay was last in front, and whether Bay is the app in front. The Little Bay service hears the
// Mac's events and tells this (service.ts); the sweep is its job on the shared grid.
export function createLittleBayPutAway(store: () => BrowserState) {
  const usedAt = new Map<string, number>();
  let appActive = true;

  // A window stops being in use when another comes forward, or Bay goes to the background.
  const leave = () => {
    const front = store().ui.focusedWindowId;

    if (front) usedAt.set(front, Date.now());
  };

  /** A window came forward or closed. */
  function noteWindowEvent(e: WindowEvent) {
    if (e.type === "focus") {
      leave();
      usedAt.set(e.id, Date.now());
      appActive = true;
    }

    if (e.type === "close") usedAt.delete(e.id);
  }

  /** Bay went to the background. */
  function noteAppEvent(e: AppEvent) {
    if (e.type !== "resignActive") return;
    leave();
    appActive = false;
  }

  /** Whether the sweep has anything to look at: a Little Bay, and a time to put it away after. */
  const putAwayNeeded = () => store().settings.littleBayPutAwayAfterHours !== null && Object.values(store().windows).some((w) => w.kind === "small");

  /** Puts away the Little Bay windows left alone for their time (by `now`): the ones it closed. */
  function putAwayIdleLittleBays(now = Date.now()): string[] {
    const s = store();

    const ids = littleBaysToPutAway(s, {
      now,
      hours: s.settings.littleBayPutAwayAfterHours,
      usedAt: (id) => usedAt.get(id),
      inUse: appActive ? s.ui.focusedWindowId : null,
    });

    // A window is closed once: closing it archives its page, and one already gone is not closed again.
    for (const id of ids) {
      usedAt.delete(id);

      if (store().windows[id]) store().closeWindow(id);
    }

    return ids;
  }

  return { noteWindowEvent, noteAppEvent, putAwayNeeded, putAwayIdleLittleBays };
}
