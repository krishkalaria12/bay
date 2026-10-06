import { useActiveTabId, useWindowId } from "../../store/hooks";
import { useAddressBarInSidebar, useUrlAnchors, sidebarSiteControlsGeometry } from "../layout/windowLayout";
import { usePopover } from "../layout/pageState";
import { SiteControls } from "../site/SiteControls";

export function SidebarSiteControls({ windowWidth, windowHeight }: { windowWidth: number; windowHeight: number }) {
  const windowId = useWindowId();
  const tabId = useActiveTabId();
  const sidebar = useAddressBarInSidebar();
  const anchor = useUrlAnchors((s) => s[windowId]);
  const popover = usePopover(tabId);
  if (!sidebar || !tabId || popover !== "siteControls" || !anchor?.sidebar || !windowWidth || !windowHeight) return null;
  return <SiteControls key={tabId} tabId={tabId} {...sidebarSiteControlsGeometry(anchor, windowWidth, windowHeight)} />;
}
