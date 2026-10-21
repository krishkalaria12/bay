import { disintegrate } from "@bay/shell";
import { reduceMotion } from "../../lib/reduceMotion";
import { cleanUpTabs } from "../../runtime/organizeActions";
import type { BrowserProjection } from "../../runtime/projection";
import { browserRead } from "../../store/read";
import { cleanUpCandidates } from "../../store/organize";
import { measureRow, type Anchor } from "./state";
import { CLEAR_MAX_ROWS } from "./constants";

// yab's Clear: every tab but the one on screen goes (put away, as Clean Up does: Recently Cleaned has them), and
// their rows break into their own pixels, which blow away (packages/shell's Disintegrate.swift) as the rows close.

/** The tabs Clear would put away in the window's space: all but the shown one, the pinned, kept, playing, grouped and split. */
export const clearableTabs = (s: BrowserProjection, windowId: string, spaceId?: string) => cleanUpCandidates(s, windowId, 0, Date.now(), spaceId);

export async function clearTabs(windowId: string) {
  const ids = clearableTabs(browserRead.getState(), windowId);
  if (!ids.length) return;
  if (!reduceMotion()) {
    const rects = (await Promise.all(ids.slice(0, CLEAR_MAX_ROWS).map((id) => measureRow(windowId, id)))).filter((r): r is Anchor => !!r);
    // The rows are drawn while they're snapshot, before they go.
    if (rects.length) await disintegrate(windowId, rects).catch(() => {});
  }
  await cleanUpTabs(windowId, { inactiveForMs: 0 });
}
