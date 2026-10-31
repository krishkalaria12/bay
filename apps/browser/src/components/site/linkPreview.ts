import { create } from "zustand";
import { copyText } from "@bay/shell";

import { useBrowserRead as useBrowser } from "../../store/read";
import { reportBrowserCommand } from "../../runtime/commands";
import { navigate } from "../../runtime/tabActions";
import { openPeek } from "../../runtime/splitActions";
import { showToast } from "../layout/splitActions";

export type LinkPreviewData = { url: string; rect: { x: number; y: number; width: number; height: number } };

export const useLinkPreview = create<Record<string, LinkPreviewData | null>>(() => ({}));

export function setLinkPreview(tabId: string, data: LinkPreviewData | null) {
  useLinkPreview.setState({ [tabId]: data });
}

// Links to files, which a preview would download whole.
const FILE_LINK = /\.(?:zip|dmg|pkg|exe|msi|iso|img|tar|gz|tgz|bz2|xz|7z|rar|pdf|mp4|mov|mkv|webm|avi|mp3|m4a|wav|flac|apk|ipa)$/i;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });

export async function fetchLinkSummary(url: string): Promise<string> {
  try {
    if (FILE_LINK.test(new URL(url).pathname)) return "No summary available.";
  } catch {
    return "Couldn't load a preview for this link.";
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 8000);
  try {
    // No cookies: the app's own network stack isn't the page's profile, and a private window's hover shouldn't leave any.
    const res = await fetch(url, { redirect: "follow", credentials: "omit", signal: abort.signal });
    if (!/html/i.test(res.headers.get("content-type") ?? "")) return "No summary available.";
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
    const text = decodeEntities(parts.join(" — ")).replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 500) : "No summary available.";
  } catch {
    return "Couldn't load a preview for this link.";
  } finally {
    clearTimeout(timer);
  }
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
