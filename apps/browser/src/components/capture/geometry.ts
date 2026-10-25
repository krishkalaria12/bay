import { CAPTURE_BAR_GAP, CAPTURE_BAR_HEIGHT, CAPTURE_MARGIN } from "./constants";

export type Box = { x: number; y: number; width: number; height: number };

/**
 * Where a capture shows over its page, and its bar: lifted from where it was taken (`from`, in the page's points), kept
 * inside the pane with room for the bar below it (else above), and scaled down only when it can't fit.
 */
export function placeCapture(from: Box, pane: { width: number; height: number }): { image: Box; barTop: number; barAbove: boolean } {
  const room = CAPTURE_BAR_HEIGHT + CAPTURE_BAR_GAP;
  const maxWidth = Math.max(40, pane.width - CAPTURE_MARGIN * 2);
  const maxHeight = Math.max(40, pane.height - CAPTURE_MARGIN * 2 - room);
  const scale = Math.min(1, maxWidth / Math.max(1, from.width), maxHeight / Math.max(1, from.height));
  const width = from.width * scale;
  const height = from.height * scale;
  // Scaled about its centre, then moved in only as far as it must.
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  const x = clamp(from.x + (from.width - width) / 2, CAPTURE_MARGIN, pane.width - CAPTURE_MARGIN - width);
  let y = from.y + (from.height - height) / 2;
  const below = y + height + room <= pane.height - CAPTURE_MARGIN;
  const above = y - room >= CAPTURE_MARGIN;
  if (!below && above) {
    y = clamp(y, CAPTURE_MARGIN + room, pane.height - CAPTURE_MARGIN - height);
    return { image: { x, y, width, height }, barTop: y - room, barAbove: true };
  }
  y = clamp(y, CAPTURE_MARGIN, pane.height - CAPTURE_MARGIN - room - height);
  return { image: { x, y, width, height }, barTop: y + height + CAPTURE_BAR_GAP, barAbove: false };
}

/** A capture's file name: the page's title (else its host) and when, as macOS names screenshots. */
export function captureName(title: string, url: string, at: Date, kind: boolean | "portrait" = false): string {
  let host = "";
  try {
    host = new URL(url).host;
  } catch {}
  const base =
    (title || host || "Capture")
      .replace(/[/\\:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60)
      .trim() || "Capture";
  const two = (n: number) => String(n).padStart(2, "0");
  const date = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
  const time = `${two(at.getHours())}.${two(at.getMinutes())}.${two(at.getSeconds())}`;
  let label = "";
  if (kind === "portrait") label = " (Portrait)";
  else if (kind) label = " (Full Page)";
  return `${base}${label} ${date} at ${time}`;
}
