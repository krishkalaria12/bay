import { useBrowser } from "../../store/browser";
import { changedIds } from "../../store/changes";
import { isIncognitoSpace } from "../../store/model";
import type { ClosedTab } from "../../store/types";

export function startCleanupNotifications(notify: (windowId: string, count: number) => void) {
  const pending = new Map<string, number>();
  let queued = false;
  let stopped = false;
  const unsubscribe = useBrowser.subscribe((s, prev) => {
    if (s.cleanedTabs === prev.cleanedTabs && s.privateCleanedTabs === prev.privateCleanedTabs) return;
    const removed = changedIds(s.tabs, prev.tabs).filter((id) => prev.tabs[id] && !s.tabs[id]);
    if (!removed.length) return;
    const add = (windowId: string | undefined, entries: ClosedTab[], before: ClosedTab[]) => {
      if (!windowId || entries === before) return;
      const known = new Set(before.map((entry) => entry.id));
      if (!entries.some((entry) => !known.has(entry.id))) return;
      // History retains only 100 entries; count the tabs removed in this cleanup instead.
      const privateWindow = s.windows[windowId]?.incognito;
      const count = removed.filter((id) => (privateWindow ? prev.tabs[id]!.windowId === windowId : !isIncognitoSpace(prev.tabs[id]!.spaceId))).length;
      if (count) pending.set(windowId, (pending.get(windowId) ?? 0) + count);
    };
    if (s.cleanedTabs !== prev.cleanedTabs) {
      const focused = s.ui.focusedWindowId;
      const regular = (id: string) => s.windows[id] && !s.windows[id]!.incognito && s.windows[id]!.kind !== "small";
      const windowId = focused && regular(focused) ? focused : s.windowOrder.find(regular);
      add(windowId, s.cleanedTabs, prev.cleanedTabs);
    }
    if (s.privateCleanedTabs !== prev.privateCleanedTabs) {
      for (const [windowId, entries] of Object.entries(s.privateCleanedTabs)) {
        add(windowId, entries, prev.privateCleanedTabs[windowId] ?? []);
      }
    }
    if (!pending.size || queued) return;
    queued = true;
    // The automatic pass cleans several spaces synchronously; show one total per window.
    queueMicrotask(() => {
      queued = false;
      if (stopped) return;
      for (const [windowId, count] of pending) {
        if (useBrowser.getState().windows[windowId]) {
          notify(windowId, count);
        }
      }
      pending.clear();
    });
  });
  return () => {
    stopped = true;
    pending.clear();
    unsubscribe();
  };
}
