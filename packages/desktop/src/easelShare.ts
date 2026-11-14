import type { EaselDocument } from "./easel";
import { safeUrl } from "./easelEditor";

export type EaselShareImage = { data: string; width: number; height: number };

/** Only the rendered picture and explicit links may leave the app. */
export function easelShareSnapshot(document: EaselDocument, title: string, image: EaselShareImage | null) {
  if (document.items.length && !image) throw new Error("Couldn't render this Easel. Try again.");
  const links: { url: string; title: string }[] = [];
  const seen = new Set<string>();

  for (const item of document.items) {
    const url = safeUrl(item.source?.url ?? item.url ?? "");

    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push({ url, title: item.source?.title ?? item.text ?? url });
  }

  const snapshot = JSON.stringify({ version: 1, title: title || "Untitled Easel", background: document.background || "#FFFFFF", image, links });

  if (new TextEncoder().encode(snapshot).byteLength > 16 * 1024 * 1024) throw new Error("This Easel is too large to share. Export it as HTML instead.");

  return snapshot;
}
