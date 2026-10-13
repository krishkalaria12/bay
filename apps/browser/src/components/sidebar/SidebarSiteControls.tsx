import { useActiveTabId, useSidebarOpen, useWindowId } from "../../store/hooks";
import { useSidebarFieldShown, useUrlAnchors, sidebarSiteControlsGeometry } from "../layout/windowLayout";
import { usePopover } from "../layout/pageState";
import { SiteControls } from "../site/SiteControls";

export function SidebarSiteControls({ windowWidth, windowHeight }: { windowWidth: number; windowHeight: number }) {
  const windowId = useWindowId();
  const tabId = useActiveTabId();
  // Closed, the field is only in the sidebar's peek, which slides away: the page shows them (ContentCard.tsx).
  const sidebarOpen = useSidebarOpen();
  const sidebar = useSidebarFieldShown() && sidebarOpen;
  const anchor = useUrlAnchors((s) => s[windowId]);
  const popover = usePopover(tabId);
  if (!sidebar || !tabId || popover !== "siteControls" || !anchor?.sidebar || !windowWidth || !windowHeight) return null;
  return <SiteControls key={tabId} tabId={tabId} {...sidebarSiteControlsGeometry(anchor, windowWidth, windowHeight)} />;
}
