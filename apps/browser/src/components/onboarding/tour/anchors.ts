import type { View } from "react-native";
import { layout } from "../../../lib/constants";
import { useBrowser } from "../../../store/browser";
import { activeTabId } from "../../../store/model";
import { splitOf } from "../../../store/splits";
import { toolbarGeometry, type Rect } from "../../layout/geometry";
import { sidebarOnRight, useUrlAnchors } from "../../layout/windowLayout";
import { measureRow } from "../../sidebar/state";
import { TOOLBAR_BUTTON_MID } from "../../layout/constants";

export type TourAnchor = "commandBar" | "page" | "tabs" | "sidebarButton";

const registered = new Map<string, View>();
const fallbacks = new Map<string, View>();
const key = (windowId: string, id: TourAnchor) => `${windowId}\n${id}`;

export const tourAnchorRef =
  (windowId: string, id: TourAnchor, fallback = false) =>
  (view: View | null) => {
    const anchors = fallback ? fallbacks : registered;
    if (view) anchors.set(key(windowId, id), view);
    else anchors.delete(key(windowId, id));
  };

function measure(view: View | undefined): Promise<Rect | null> {
  if (!view) return Promise.resolve(null);
  return new Promise((resolve) => view.measureInWindow((x, y, width, height) => resolve(width && height ? { x, y, width, height } : null)));
}

export async function locateAnchor(windowId: string, id: TourAnchor): Promise<Rect | null> {
  const s = useBrowser.getState();
  const w = s.windows[windowId];
  if (!w) return null;
  const tabLayout = w.tabLayout ?? s.settings.tabLayout;
  switch (id) {
    case "commandBar":
    case "page":
      return measure(registered.get(key(windowId, id)) ?? fallbacks.get(key(windowId, id)));
    case "tabs": {
      const tabId = activeTabId(s, windowId);
      return w.sidebarOpen && tabLayout === "sidebar" && tabId ? measureRow(windowId, tabId) : null;
    }
    case "sidebarButton": {
      const url = useUrlAnchors.getState()[windowId];
      if (!url || url.sidebar || tabLayout !== "sidebar" || splitOf(s, activeTabId(s, windowId))) return null;
      const size = layout.toolbarButton;
      // With the sidebar on the right the toggle is at the toolbar's end: 8pt in from the pane's edge, 12pt past the field.
      if (sidebarOnRight(s, windowId))
        return { x: url.left + url.width + 12 - 8 - size, y: url.top + TOOLBAR_BUTTON_MID - size / 2, width: size, height: size };
      const g = toolbarGeometry({ sidebarButton: true, clearTrafficLights: !w.sidebarOpen });
      if (g.sidebarButton === null) return null;
      return { x: url.left - g.urlLeft + g.sidebarButton - size / 2, y: url.top + TOOLBAR_BUTTON_MID - size / 2, width: size, height: size };
    }
  }
}
