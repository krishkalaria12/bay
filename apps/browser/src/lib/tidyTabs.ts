import { offersTidy } from "@bay/core";
import * as Effect from "effect/Effect";
import { create } from "zustand";
import { showToast } from "../components/ui/toasts";
import { runDesktop } from "../effect/runtime";
import { useBrowser } from "../store/browserStore";
import { plural } from "../store/model";
import { tidyTabCounts } from "../store/tabTidying";
import { TidyWorkService } from "./tidyWorkService";

// Tidy Tabs: the model proposes groups for a space's loose tabs, and the store applies them. Where the model can't
// answer (no Apple Intelligence, a private window, a refusal) the tabs are grouped by site, so Tidy always does something.
//
// The work is the service's (lib/tidyWorkService.ts): it asks the model, waits for it, and checks that the window and
// its tabs are still the ones it planned for. This module is what the app sees: the wave, the offer and the toast.

/** The wave's way back to flat (TidySquiggleView). */
export const TIDY_SQUIGGLE_SETTLE_MS = 400;

type TidyTabsState = {
  /** Spaces Tidy is sorting: the divider waves while they are. */
  running: Record<string, true>;
  /** Per space, the tabs Tidy last left loose: it waits for another, so undoing a run offers it again. Not saved. */
  tidied: Record<string, ReadonlySet<string>>;
};

export const useTidyTabs = create<TidyTabsState>(() => ({ running: {}, tidied: {} }));

function setRunning(spaceId: string, on: boolean) {
  useTidyTabs.setState(({ running }) => {
    const { [spaceId]: _, ...rest } = running;

    return { running: on ? { ...rest, [spaceId]: true } : rest };
  });
}

/** The tabs Tidy left loose: it waits for another one before it offers itself again. */
function markTidied(spaceId: string, loose: readonly string[]) {
  useTidyTabs.setState(({ tidied }) => ({ tidied: { ...tidied, [spaceId]: new Set(loose) } }));
}

/** Whether the divider shows Tidy, and whether it's working. */
export function useTidyOffer(windowId: string, spaceId: string) {
  const running = useTidyTabs((t) => !!t.running[spaceId]);
  const tidied = useTidyTabs((t) => t.tidied[spaceId] ?? null);

  const offered = useBrowser((s) => {
    if (!s.settings.tidyTabs) return false;
    const { tabCount, loose } = tidyTabCounts(s, windowId, spaceId);

    return offersTidy(tabCount, loose, tidied);
  });

  return { offered, running };
}

/** The sidebar's Tidy, its menus' and the command bar's. */
export async function runTidyTabs(windowId: string): Promise<void> {
  const before = useBrowser.getState();
  const w = before.windows[windowId];

  if (!w) return;
  const spaceId = w.spaceId;

  // The wave: the divider shows that the tabs are being sorted.
  setRunning(spaceId, true);

  // The service says when the space is already being tidied. That run owns the wave, not this one.
  let ours = true;

  try {
    const outcome = await runDesktop(
      Effect.gen(function* () {
        const tidy = yield* TidyWorkService;

        return yield* tidy.run({ windowId });
      }),
    );

    if (outcome.kind === "busy") {
      ours = false;

      return;
    }

    // The window is gone: there is nothing to show.
    if (outcome.kind === "gone") return;

    markTidied(spaceId, outcome.loose);

    if (outcome.kind === "nothing") {
      showToast(windowId, "Nothing to Tidy", "These tabs have too little in common to group.", { icon: "rectangle.stack" });

      return;
    }

    showToast(windowId, "Tabs Tidied", `${plural(outcome.moved, "tab")} sorted into ${plural(outcome.groups, "group")}.`, {
      icon: "rectangle.stack",
      key: `tidy-tabs:${spaceId}`,
      duration: 6000,
      action: { title: "Undo", run: () => void useBrowser.getState().undoSidebarEdit(windowId) },
    });
  } finally {
    if (ours) setRunning(spaceId, false);
  }
}
