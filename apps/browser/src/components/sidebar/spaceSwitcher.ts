import { reportBrowserCommand } from "../../runtime/commands";
import * as tabCommands from "../../runtime/tabActions";
import { isMac } from "@bay/platform";
import { setSwitcherCapture } from "@bay/desktop";
import { webviews } from "../../lib/webviews";
import { activeTabId } from "../../store/model";
import { useBrowserRead as useBrowser } from "../../store/read";
import { recentTabIds } from "../../store/tabTidying";
import { setSidebarUi, sidebarUi } from "./state";
import { SWITCHER_SHOW_AFTER_MS } from "./constants";
import { startWebSwitcherCapture } from "./webSwitcher";

let showTimer: ReturnType<typeof setTimeout> | undefined;
let webCapture: ReturnType<typeof startWebSwitcherCapture> | null = null;

function startCapture() {
  if (isMac) return setSwitcherCapture(true);
  webCapture?.stop();
  webCapture = startWebSwitcherCapture({ move: moveSwitcher, cancel: cancelSwitcher, commit: () => commitSwitcher() });
}
/** Whether the switcher was opened from a page, whose focus it took. */
function stopCapture(): boolean {
  if (isMac) {
    setSwitcherCapture(false);
    return false;
  }
  const fromPage = !!webCapture?.fromPage;
  webCapture?.stop();
  webCapture = null;
  return fromPage;
}
const focusPage = (tabId: string | null | undefined) => void (tabId ? webviews.get(tabId)?.focus() : undefined);

export function switcherStep(windowId: string, backward: boolean) {
  const current = sidebarUi().switcher;
  if (current && current.windowId === windowId) return moveSwitcher(backward ? -1 : 1);
  const ids = recentTabIds(useBrowser.getState(), windowId);
  if (ids.length < 2) return;
  setSidebarUi({ switcher: { windowId, ids, index: backward ? ids.length - 1 : 1, visible: false } });
  startCapture();
  clearTimeout(showTimer);
  showTimer = setTimeout(() => {
    const s = sidebarUi().switcher;
    if (s) setSidebarUi({ switcher: { ...s, visible: true } });
  }, SWITCHER_SHOW_AFTER_MS);
}

export function moveSwitcher(step: 1 | -1) {
  const s = sidebarUi().switcher;
  if (s) focusSwitcherRow(s.index + step);
}

export function focusSwitcherRow(index: number) {
  const s = sidebarUi().switcher;
  if (!s) return;
  const n = s.ids.length;
  setSidebarUi({ switcher: { ...s, index: (index + n) % n } });
}

export function commitSwitcher(index?: number) {
  const s = sidebarUi().switcher;
  if (!s) return;
  const fromPage = endSwitcher();
  const id = s.ids[index ?? s.index];
  if (id && useBrowser.getState().tabs[id]) {
    const activated = tabCommands.activate(id, s.windowId);
    reportBrowserCommand(fromPage ? activated.then(() => focusPage(id)) : activated);
  } else if (fromPage) focusPage(activeTabId(useBrowser.getState(), s.windowId));
}

export function cancelSwitcher() {
  const s = sidebarUi().switcher;
  if (s && endSwitcher()) focusPage(activeTabId(useBrowser.getState(), s.windowId));
}

function endSwitcher(): boolean {
  clearTimeout(showTimer);
  const fromPage = stopCapture();
  setSidebarUi({ switcher: null });
  return fromPage;
}
