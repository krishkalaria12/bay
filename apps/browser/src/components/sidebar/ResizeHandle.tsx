import { View } from "@bay/platform";

import { useBrowser } from "../../store/browser";
import { useResizeDrag } from "../layout/useResizeDrag";
import { useSidebarOnRight } from "../layout/windowLayout";
import { setSidebarUi, sidebarUi } from "./state";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "./tokens";

export function ResizeHandle({ windowId }: { windowId: string }) {
  // The sidebar's edge toward the page: its left on the window's right, where dragging left widens it.
  const right = useSidebarOnRight();
  const handlers = useResizeDrag({
    min: SIDEBAR_MIN_WIDTH,
    max: SIDEBAR_MAX_WIDTH,
    direction: right ? -1 : 1,
    saved: () => useBrowser.getState().settings.sidebarWidth ?? 190,
    onLive: (w) => {
      const dragWidth = { ...sidebarUi().dragWidth };
      if (w === null) delete dragWidth[windowId];
      else dragWidth[windowId] = Math.round(w * 2) / 2;
      setSidebarUi({ dragWidth });
    },
    onCommit: (w) => useBrowser.getState().updateSettings({ sidebarWidth: w }),
  });
  return (
    <View
      {...handlers}
      onDoubleClick={() => useBrowser.getState().updateSettings({ sidebarWidth: 190 })}
      style={[{ position: "absolute", top: 46, bottom: 0, width: 7, cursor: "col-resize" }, right ? { left: -3 } : { right: -3 }]}
    />
  );
}
