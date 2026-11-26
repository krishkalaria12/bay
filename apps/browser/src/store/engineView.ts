import { create } from "zustand";
import { useBrowserRead as useBrowser } from "./read";
import type { BrowserProjection, DeepReadonly } from "../runtime/projection";
import type { EnginePrefs } from "./engines";
import { changedIds } from "./recordDiff";
import type { Tab } from "./types";

type EngineView = Pick<BrowserProjection, "tabs"> & { settings: DeepReadonly<EnginePrefs> };

const prefsOf = (settings: DeepReadonly<EnginePrefs>): DeepReadonly<EnginePrefs> => ({
  engineMode: settings.engineMode,
  defaultEngine: settings.defaultEngine,
  siteEngines: settings.siteEngines,
  streamingInWebKit: settings.streamingInWebKit,
});

const samePrefs = (a: DeepReadonly<EnginePrefs>, b: DeepReadonly<EnginePrefs>) =>
  a.engineMode === b.engineMode && a.defaultEngine === b.defaultEngine && a.siteEngines === b.siteEngines && a.streamingInWebKit === b.streamingInWebKit;

// Every tab icon has an engine badge selector, and every page a view chosen by its engine. Publish only when what
// engine selection reads changed, so page progress, selection, titles and the stamp of a tab switch don't run those
// selectors across every mounted sidebar, strip and page. `tabs` here can be older than the store's only in other fields.
export const useEngineView = create<EngineView>()(() => ({ tabs: useBrowser.getState().tabs, settings: prefsOf(useBrowser.getState().settings) }));

const sameEngineInputs = (a: DeepReadonly<Tab> | undefined, b: DeepReadonly<Tab> | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    a.engine === b.engine &&
    a.url === b.url &&
    a.navigation === b.navigation &&
    a.adoptId === b.adoptId &&
    a.wakeAdoptId === b.wakeAdoptId &&
    a.openerId === b.openerId &&
    a.enginePick === b.enginePick);

useBrowser.subscribe((s, prev) => {
  const tabs = s.tabs !== prev.tabs && changedIds(s.tabs, prev.tabs).some((id) => !sameEngineInputs(s.tabs[id], prev.tabs[id]));
  const prefs = s.settings !== prev.settings && !samePrefs(s.settings, useEngineView.getState().settings);

  if (tabs || prefs) useEngineView.setState({ tabs: s.tabs, ...(prefs ? { settings: prefsOf(s.settings) } : undefined) });
});
