import { MAX_TIDY_TABS, offersTidy, planTidyTabs, tidyTabsPrompt, type TidyTab } from "@bay/core";
import { tidyTabsModel } from "@bay/desktop";
import { create } from "zustand";
import { live } from "../activity/activityStore";
import { showToast } from "../components/ui/toasts";
import { useBrowser, type BrowserState } from "../store/browserStore";
import { plural } from "../store/model";
import { groupLabel, hostOfTab, siteTidyPlan, tidyCandidates, tidyTabCounts, type TabTidyPlan } from "../store/tabTidying";

// Tidy Tabs: the model proposes groups for a space's loose tabs, and the store applies them. Where the model can't
// answer (no Apple Intelligence, a private window, a refusal) the tabs are grouped by site, so Tidy always does something.

/** The wave's way back to flat (TidySquiggleView). */
export const TIDY_SQUIGGLE_SETTLE_MS = 400;
// A quick answer doesn't flash: the wave runs at least this long.
const MINIMUM_RUN_MS = 900;

type TidyTabsState = {
  /** Spaces the model is sorting. */
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

function markTidied(s: BrowserState, windowId: string, spaceId: string) {
  useTidyTabs.setState(({ tidied }) => ({ tidied: { ...tidied, [spaceId]: new Set(tidyTabCounts(s, windowId, spaceId).loose) } }));
}

/** Whether the divider shows Tidy, and whether it's working. */
export function useTidyOffer(windowId: string, spaceId: string): { offered: boolean; running: boolean } {
  const running = useTidyTabs((t) => !!t.running[spaceId]);
  const tidied = useTidyTabs((t) => t.tidied[spaceId] ?? null);
  const offered = useBrowser((s) => {
    if (!s.settings.tidyTabs) return false;
    const { tabCount, loose } = tidyTabCounts(s, windowId, spaceId);
    return offersTidy(tabCount, loose, tidied);
  });
  return { offered, running };
}

// Named groups the model may add to. A meeting's group closes with its meeting, and one a pinned tab opened belongs to it.
function joinableGroups(s: BrowserState, spaceId: string) {
  const meetings = live().meetingGroups;
  return Object.values(s.groups).filter((g) => g.spaceId === spaceId && !!g.name && !g.pinned && !g.pinnedOpenerId && !meetings[g.id]);
}

const tabForModel = (s: BrowserState, id: string): TidyTab => {
  const t = s.tabs[id]!;
  return { title: t.customTitle || t.title, host: hostOfTab(t) };
};

async function modelPlan(model: NonNullable<typeof tidyTabsModel>, s: BrowserState, ids: string[], spaceId: string): Promise<TabTidyPlan | null> {
  const groups = joinableGroups(s, spaceId);
  const names = groups.map((g) => groupLabel(s, g));
  const prompt = tidyTabsPrompt(
    ids.map((id) => tabForModel(s, id)),
    names,
  );
  const answer = await model.group(prompt).catch(() => null);
  if (!answer) return null;
  const plan = planTidyTabs(answer, ids.length, names);
  const tabIds = (tabs: number[]) => tabs.map((tab) => ids[tab]!);
  return {
    newGroups: plan.newGroups.map((group) => ({ name: group.name, tabIds: tabIds(group.tabs) })),
    joins: plan.joins.map((join) => ({ groupId: groups[join.group]!.id, tabIds: tabIds(join.tabs) })),
  };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The sidebar's Tidy, its menus' and the command bar's. */
export async function runTidyTabs(windowId: string): Promise<void> {
  const before = useBrowser.getState();
  const w = before.windows[windowId];
  if (!w) return;
  const spaceId = w.spaceId;
  if (useTidyTabs.getState().running[spaceId]) return;
  const ids = tidyCandidates(before, windowId, spaceId).slice(0, MAX_TIDY_TABS);
  let plan: TabTidyPlan | null = null;
  // A private window's tabs don't go to the model, on this Mac or not.
  const model = w.incognito ? null : tidyTabsModel;
  if (ids.length >= 2 && model?.modelStatus() === "available") {
    const started = Date.now();
    setRunning(spaceId, true);
    try {
      plan = await modelPlan(model, before, ids, spaceId);
      await delay(MINIMUM_RUN_MS - (Date.now() - started));
    } finally {
      setRunning(spaceId, false);
    }
  }

  const s = useBrowser.getState();
  if (!s.windows[windowId]) return;
  const modelGrouped = !!plan && (plan.newGroups.length > 0 || plan.joins.length > 0);
  const stillOpen = ids.filter((id) => s.tabs[id]);
  const count = s.tidyTabs(windowId, modelGrouped ? plan! : siteTidyPlan(s, stillOpen));
  const after = useBrowser.getState();
  markTidied(after, windowId, spaceId);
  if (!count) {
    showToast(windowId, "Nothing to Tidy", "These tabs have too little in common to group.", { icon: "rectangle.stack" });
    return;
  }
  const moved = tidyCandidates(s, windowId, spaceId).length - tidyCandidates(after, windowId, spaceId).length;
  showToast(windowId, "Tabs Tidied", `${plural(moved, "tab")} sorted into ${plural(count, "group")}.`, {
    icon: "rectangle.stack",
    key: `tidy-tabs:${spaceId}`,
    duration: 6000,
    action: { title: "Undo", run: () => void useBrowser.getState().undoSidebarEdit(windowId) },
  });
}
