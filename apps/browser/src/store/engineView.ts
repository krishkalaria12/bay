import { create } from "zustand";
import { useBrowser, type BrowserState } from "./browser";
import { changedIds } from "./changes";
import type { Tab } from "./types";

type EngineView = Pick<BrowserState, "tabs" | "settings">;

// Every tab icon has an engine badge selector, and every page a view chosen by its engine. Publish only when what
// engine selection reads changed, so page progress, selection, titles and the stamp of a tab switch don't run those
// selectors across every mounted sidebar, strip and page. `tabs` here can be older than the store's only in other fields.
export const useEngineView = create<EngineView>()(() => {
  const { tabs, settings } = useBrowser.getState();
  return { tabs, settings };
});

const sameEngineInputs = (a: Tab | undefined, b: Tab | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    a.engine === b.engine &&
    a.url === b.url &&
    a.navigation === b.navigation &&
    a.adoptId === b.adoptId &&
    a.wakeAdoptId === b.wakeAdoptId &&
    a.openerId === b.openerId);

useBrowser.subscribe((s, prev) => {
  if (s.settings !== prev.settings || (s.tabs !== prev.tabs && changedIds(s.tabs, prev.tabs).some((id) => !sameEngineInputs(s.tabs[id], prev.tabs[id]))))
    useEngineView.setState({ tabs: s.tabs, settings: s.settings });
});
