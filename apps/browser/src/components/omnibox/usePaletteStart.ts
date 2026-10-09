import { useBrowser } from "../../store/browser";
import { NO_HISTORY } from "../../store/constants";
import { paletteStart } from "./paletteStart";


export function usePaletteStart(windowId: string, spaceId: string, tabId: string) {
  const tabs = useBrowser((s) => s.tabs);
  const history = useBrowser((s) => s.history[spaceId] ?? NO_HISTORY);
  return paletteStart(Object.values(tabs).filter((t) => t.windowId === windowId && t.spaceId === spaceId), history, tabId);
}
