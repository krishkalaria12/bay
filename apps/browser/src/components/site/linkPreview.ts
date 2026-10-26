import { create } from "zustand";
import { copyText } from "@bay/shell";

import { useBrowser } from "../../store/browser";
import { showToast } from "../layout/splitActions";

export type LinkPreviewData = { url: string; rect: { x: number; y: number; width: number; height: number } };

export const useLinkPreview = create<Record<string, LinkPreviewData | null>>(() => ({}));

export function setLinkPreview(tabId: string, data: LinkPreviewData | null) {
  useLinkPreview.setState({ [tabId]: data });
}

export async function fetchLinkSummary(url: string): Promise<string> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    const html = await res.text();
    const title = html
      .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ?.replace(/<[^>]+>/g, "")
      .trim();
    const descMatch =
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i) ||
      html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["']/i);
    const desc = descMatch?.[1]?.trim();
    const pMatch = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const p = pMatch?.[1]?.replace(/<[^>]+>/g, "").trim();
    const parts = [title, desc, p].filter(Boolean) as string[];
    const text = parts.join(" — ").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 500) : "No summary available.";
  } catch {
    return "Couldn't load a preview for this link.";
  }
}

export function openLinkPreview(tabId: string, url: string) {
  const tab = useBrowser.getState().tabs[tabId];
  if (!tab) return;
  setLinkPreview(tabId, null);
  useBrowser.getState().navigate(tabId, url, { userInitiated: true });
}

export function peekLinkPreview(tabId: string, url: string) {
  const store = useBrowser.getState();
  if (!store.tabs[tabId]) return;
  setLinkPreview(tabId, null);
  store.openPeek(tabId, url);
}

export function copyLinkPreview(tabId: string, url: string) {
  const tab = useBrowser.getState().tabs[tabId];
  if (!tab) return;
  copyText(url);
  showToast(tab.windowId, "Copied Link", undefined, { icon: "link" });
  setLinkPreview(tabId, null);
}
