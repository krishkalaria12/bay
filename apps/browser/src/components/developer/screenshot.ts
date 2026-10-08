import { copyImage } from "@bay/shell";
import { webviews } from "../../lib/webviews";
import { useBrowser } from "../../store/browser";
import { showToast } from "../layout/splitActions";

/** The page as it's shown, on the clipboard: a PNG at the screen's scale. */
export async function copyScreenshot(tabId: string) {
  const tab = useBrowser.getState().tabs[tabId];
  if (!tab) return;
  const png = await webviews.get(tabId)?.captureScreenshot();
  if (png && copyImage(png)) showToast(tab.windowId, "Copied Screenshot", "The page as it's shown now.", { icon: "camera" });
  else showToast(tab.windowId, "Couldn’t Take a Screenshot", "The page didn’t paint in time.", { icon: "camera" });
}
