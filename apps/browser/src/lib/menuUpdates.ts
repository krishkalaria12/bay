import { useBrowser } from "../store/browserStore";
import { quietStore } from "../store/derivedStores";
import { activeTabId, IDLE_LIVE } from "../store/model";
import { IDLE_PAGE, usePages } from "../components/window/pageState";

function focusedTabId(): string | undefined {
  const s = useBrowser.getState();
  const id = s.ui.focusedWindowId;

  return id && s.windows[id] ? activeTabId(s, id) : undefined;
}

/** Menus read all durable state, but only the focused tab's loading and navigation flags from page reports. */
export function subscribeMenuInputs(changed: () => void): () => void {
  const stops = [
    quietStore.subscribe(changed),
    useBrowser.subscribe((s, prev) => {
      if (s.live === prev.live) return;
      const id = focusedTabId();

      if (!id) return;
      const live = s.live[id] ?? IDLE_LIVE;
      const before = prev.live[id] ?? IDLE_LIVE;

      if (live.isLoading !== before.isLoading || live.canGoBack !== before.canGoBack || live.canGoForward !== before.canGoForward) changed();
    }),
    usePages.subscribe((s, prev) => {
      if (s.pages === prev.pages) return;
      const id = focusedTabId();

      if (!id) return;
      const page = s.pages[id] ?? IDLE_PAGE;
      const before = prev.pages[id] ?? IDLE_PAGE;

      if (page.backToNewTab !== before.backToNewTab || !!page.engineBack !== !!before.engineBack || !!page.newTabShown !== !!before.newTabShown) changed();
    }),
  ];

  return () => stops.forEach((stop) => stop());
}
