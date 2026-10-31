import { onAppEvent, onWindowEvent } from "@bay/shell";
import { everySlowly } from "../../lib/slowTimers";
import { useBrowserRead as useBrowser } from "../../store/read";
import type { BrowserProjection } from "../../runtime/projection";
import { reportBrowserCommand } from "../../runtime/commands";
import { closeWindow } from "../../runtime/windowActions";
import { activeTabId } from "../../store/model";
import { PUT_AWAY_SWEEP_MS } from "./constants";

// Little Bay windows left alone are put away, as Arc did with Little Arc (every six hours by default, its time in
// Settings › Links): the window closes and its page goes to the Library's archive, under Little Bay. One in front,
// or playing sound, stays.

const HOUR = 60 * 60_000;

/**
 * The Little Bay windows to put away: unused for `hours` (since they were last in front, or opened). `inUse`: the
 * window in front while Bay is the active app, which is never idle.
 */
export function littleBaysToPutAway(
  s: BrowserProjection,
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

let started = false;
const usedAt = new Map<string, number>();
let appActive = true;
const store = () => useBrowser.getState();

/** Puts away the Little Bay windows left alone for their time (by `now`): the ones it closed. */
export function putAwayIdleLittleBays(now = Date.now()): string[] {
  const s = store();
  const ids = littleBaysToPutAway(s, {
    now,
    hours: s.settings.littleBayPutAwayAfterHours,
    usedAt: (id) => usedAt.get(id),
    inUse: appActive ? s.ui.focusedWindowId : null,
  });
  for (const id of ids) {
    usedAt.delete(id);
    reportBrowserCommand(closeWindow(id));
  }
  return ids;
}

export function startLittleBayPutAway() {
  if (started) return;
  started = true;
  // A window stops being in use when another comes forward, or Bay goes to the background.
  const leave = () => {
    const front = store().ui.focusedWindowId;
    if (front) usedAt.set(front, Date.now());
  };
  onWindowEvent((e) => {
    if (e.type === "focus") {
      leave();
      usedAt.set(e.id, Date.now());
      appActive = true;
    }
    if (e.type === "close") usedAt.delete(e.id);
  });
  onAppEvent((e) => {
    if (e.type !== "resignActive") return;
    leave();
    appActive = false;
  });
  everySlowly({
    every: PUT_AWAY_SWEEP_MS,
    run: () => void putAwayIdleLittleBays(),
    needed: () => store().settings.littleBayPutAwayAfterHours !== null && Object.values(store().windows).some((w) => w.kind === "small"),
    watch: (changed) =>
      useBrowser.subscribe((s, prev) => {
        if (s.windows !== prev.windows || s.settings !== prev.settings) changed();
      }),
  });
}
