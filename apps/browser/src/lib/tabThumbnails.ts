import { useBrowser } from "../store/browserStore";
import { isIncognitoSpace } from "../store/model";
import { MAX_TAB_PICTURES } from "./constants";
import { askPicture, type Picture } from "./enrichmentService";

// The last picture of each tab's page, for dragging a tab that isn't on screen (a page out of view isn't
// painted, so it can't be captured then). Taken once a tab has been shown for a moment; memory only, never for
// private windows, the most recent few.
//
// The taking is the enrichment service's work: it waits for the tab to settle and drops the picture when the
// window shows another tab by then. What is here is the cache of what came back.
const pictures = new Map<string, Picture>();
let started = false;

export function lastPicture(tabId: string): Picture | null {
  return pictures.get(tabId) ?? null;
}

function remember(tabId: string, picture: Picture) {
  pictures.delete(tabId);
  pictures.set(tabId, picture);

  for (const old of pictures.keys()) {
    if (pictures.size <= MAX_TAB_PICTURES) break;
    pictures.delete(old);
  }
}

/** Watches the tabs windows show and keeps their pictures. */
export function startTabPictures() {
  if (started) return;
  started = true;
  useBrowser.subscribe((s, prev) => {
    if (s.windows === prev.windows && s.tabs === prev.tabs && s.tabLists === prev.tabLists) return;

    for (const w of Object.values(s.windows)) {
      const id = w.activeTabIds[w.spaceId];

      if (!id || w.incognito) continue;
      // A tab just shown (another tab, or another profile's page), or the one shown going to another page.
      const was = prev.windows[w.id];

      if (id === was?.activeTabIds[was.spaceId] && s.tabs[id]?.url === prev.tabs[id]?.url) continue;

      if (isIncognitoSpace(s.tabs[id]?.spaceId ?? "")) continue;

      askPicture({
        windowId: w.id,
        tabId: id,
        onPicture: (picture) => {
          if (picture) remember(id, picture);
        },
      });
    }

    if (s.tabs !== prev.tabs) for (const id of pictures.keys()) if (!s.tabs[id]) pictures.delete(id);
  });
}
