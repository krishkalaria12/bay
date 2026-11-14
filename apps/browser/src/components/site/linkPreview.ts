import { navigate } from "../../runtime/tabActions";
import { openPeek } from "../../runtime/splitActions";
import { reportBrowserCommand } from "../../runtime/commands";
import { create } from "zustand";
import { copyText } from "@bay/desktop";
import * as Effect from "effect/Effect";

import { runWindow } from "../../effect/windowRuntime";
import { useBrowserRead as useBrowser } from "../../store/read";
import { showToast } from "../split/splitActions";
import { PreviewService } from "./previewService";

export type LinkPreviewData = { url: string; rect: { x: number; y: number; width: number; height: number } };

export const useLinkPreview = create<Record<string, LinkPreviewData | null>>(() => ({}));

export function setLinkPreview(tabId: string, data: LinkPreviewData | null) {
  useLinkPreview.setState({ [tabId]: data });
}

/** What the page at the link says about itself. */
export function fetchLinkSummary(url: string): Promise<string> {
  return runWindow(
    Effect.gen(function* () {
      const preview = yield* PreviewService;

      return yield* preview.summary(url);
    }),
  );
}

export function openLinkPreview(tabId: string, url: string) {
  const tab = useBrowser.getState().tabs[tabId];

  if (!tab) return;
  setLinkPreview(tabId, null);
  reportBrowserCommand(navigate(tabId, url, { userInitiated: true }));
}

export function peekLinkPreview(tabId: string, url: string) {
  const store = useBrowser.getState();

  if (!store.tabs[tabId]) return;
  setLinkPreview(tabId, null);
  reportBrowserCommand(openPeek(tabId, url));
}

export function copyLinkPreview(tabId: string, url: string) {
  const tab = useBrowser.getState().tabs[tabId];

  if (!tab) return;
  copyText(url);
  showToast(tab.windowId, "Copied Link", undefined, { icon: "link" });
  setLinkPreview(tabId, null);
}
