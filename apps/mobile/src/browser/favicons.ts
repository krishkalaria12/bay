import { runPageScript, type Tab } from "@bay/engine";
import { Directory, File, Paths } from "expo-file-system";

import { FAVICON_SCRIPT, type FaviconSource } from "@/pagescripts/favicon";
import { useBrowserStore } from "@/store/browser";
import { siteHost } from "@/store/model";

// Site icons come from the site itself while it's open (no third-party icon service learns what you browse), are
// downloaded once without cookies, and are drawn from the local copy afterwards, so showing them makes no requests.
const folder = new Directory(Paths.cache, "favicons");
const MAX_BYTES = 64 * 1024;
const pending = new Set<string>();

/** Saves the open page's icon if its site has none yet. */
export function fetchFavicon(view: Tab, url: string): void {
  const host = siteHost(url);
  if (!host || pending.has(host) || useBrowserStore.getState().data.favicons[host]) return;
  pending.add(host);
  void (async () => {
    const icon = await runPageScript<FaviconSource | null>(view, FAVICON_SCRIPT);
    if (!icon || !/^https?:/.test(icon.href)) return;
    if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
    const file = await File.downloadFileAsync(icon.href, new File(folder, encodeURIComponent(host)), {
      idempotent: true,
      headers: { "User-Agent": icon.userAgent, Accept: "image/*" },
    });
    if (file.size < 16 || file.size > MAX_BYTES) return file.delete();
    useBrowserStore.getState().dispatch({ type: "favicon", host, uri: file.uri });
  })()
    .catch(() => {})
    .finally(() => pending.delete(host));
}

// Clearing history or browsing data drops icons from the store; their files go with them.
useBrowserStore.subscribe((state, previous) => {
  if (state.data.favicons === previous.data.favicons) return;
  for (const [host, uri] of Object.entries(previous.data.favicons)) {
    if (state.data.favicons[host] === uri) continue;
    try {
      const file = new File(uri);
      if (file.exists) file.delete();
    } catch {
      /* Already gone. */
    }
  }
});
