import type { Anchor } from "./store";

export function extensionPopupGeometry(anchor: Anchor, size: { width: number; height: number }, window: { width: number; height: number }) {
  const width = Math.min(size.width + 1, Math.max(1, window.width - 16));
  const height = Math.min(size.height + 1, Math.max(1, window.height - 16));
  const left = Math.max(8, Math.min(anchor.x + anchor.width - width, window.width - width - 8));
  const top = Math.max(8, Math.min(anchor.y + anchor.height + 6, window.height - height - 8));
  return { width, height, left, top };
}
