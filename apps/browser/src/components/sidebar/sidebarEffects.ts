import { onAppEvent } from "@bay/desktop";
import * as Effect from "effect/Effect";
import { runDesktop } from "../../effect/runtime";
import { Scheduler } from "../../effect/ports/scheduler";
import { webviews } from "../../lib/webviews";
import { startLive } from "../../activity/index";
import { useBrowser } from "../../store/browserStore";
import { changedIds } from "../../store/recordDiff";
import { cancelSwitcher, commitSwitcher, moveSwitcher } from "./spaceSwitcher";
import { AUTO_CLEAN_EVERY_MS } from "./constants";
import { startCleanupNotifications } from "./cleanupNotifications";
import { showToast } from "../split/splitActions";

let started = false;

export function startSidebarEffects() {
  if (started) return;
  started = true;
  startLive();
  // Effects start after session hydration, so saved cleaned tabs don't replay a notice.
  startCleanupNotifications((windowId, count) => {
    showToast(windowId, `${count} ${count === 1 ? "tab" : "tabs"} cleaned`, undefined, { icon: "wand.and.stars" });
  });

  useBrowser.subscribe((s, prev) => {
    for (const id of changedIds(s.tabs, prev.tabs)) {
      const muted = s.tabs[id]?.muted;

      if (muted !== undefined && prev.tabs[id] && prev.tabs[id]!.muted !== muted) void webviews.get(id)?.setMuted(muted);
    }
  });

  onAppEvent((e) => {
    if (e.type === "resignActive" || e.type === "screenLocked") useBrowser.getState().closeAbandonedNewTabs();

    if (e.type === "controlReleased" || e.type === "resignActive") commitSwitcher();

    if (e.type === "switcherMouseUp" || (e.type === "switcherKey" && e.key === "escape")) cancelSwitcher();

    if (e.type === "switcherKey" && e.key !== "escape") moveSwitcher(e.key === "next" ? 1 : -1);
  });

  // The clean-up of inactive tabs is a job on the app's grid: it wakes the app with the rest of the periodic work, and
  // the app's scope owns it.
  void runDesktop(
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;

      yield* scheduler.every({ every: AUTO_CLEAN_EVERY_MS, run: Effect.sync(() => useBrowser.getState().cleanUpInactiveTabs()) });
    }),
  );
}
