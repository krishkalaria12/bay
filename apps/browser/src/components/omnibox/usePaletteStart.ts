import { useMemo } from "react";
import { useBrowser } from "../../store/browser";
import type { HistoryEntry } from "../../store/types";
import { paletteStart } from "./paletteStart";

const NO_HISTORY: HistoryEntry[] = [];

export function usePaletteStart(windowId: string, profileId: string, tabId: string) {
  const tabs = useBrowser((s) => s.tabs);
  const history = useBrowser((s) => s.history[profileId] ?? NO_HISTORY);
  return useMemo(() => paletteStart(Object.values(tabs).filter((t) => t.windowId === windowId && t.profileId === profileId), history, tabId), [tabs, history, windowId, profileId, tabId]);
}
