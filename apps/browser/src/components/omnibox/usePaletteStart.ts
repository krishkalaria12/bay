import { useBrowser } from "../../store/browser";
import { NO_HISTORY } from "../../store/constants";
import { paletteStart } from "./paletteStart";


export function usePaletteStart(windowId: string, profileId: string, tabId: string) {
  const tabs = useBrowser((s) => s.tabs);
  const history = useBrowser((s) => s.history[profileId] ?? NO_HISTORY);
  return paletteStart(Object.values(tabs).filter((t) => t.windowId === windowId && t.profileId === profileId), history, tabId);
}
