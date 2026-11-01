import { create } from "zustand";
import { useBrowser, type BrowserState } from "./browser";

type EngineView = Pick<BrowserState, "tabs" | "settings">;

// Every tab icon has an engine badge selector. Publish only the records engine selection reads, so page progress,
// audio and selection updates don't run those selectors across every mounted sidebar and strip.
export const useEngineView = create<EngineView>()(() => {
  const { tabs, settings } = useBrowser.getState();
  return { tabs, settings };
});

useBrowser.subscribe((s, prev) => {
  if (s.tabs !== prev.tabs || s.settings !== prev.settings) useEngineView.setState({ tabs: s.tabs, settings: s.settings });
});
