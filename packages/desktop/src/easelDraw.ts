import type { EaselDocument, EaselItem } from "./easel";
import { contentBounds, itemPoints, itemRect, type Rect } from "./easelEditor";

// Draws an Easel: on the canvas and for export. The port of EaselDrawing (ios/Easel.swift).

export type EaselImages = (path: string) => CanvasImageSource | null;
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const FONT = 'system-ui, -apple-system, "Segoe UI", Ubuntu, sans-serif';
const MAX_EDGE = 16384;
const MAX_PIXELS = 32_000_000;

/** The scale that keeps a width × height picture within what a canvas can hold. */
export const boundedScale = (width: number, height: number) =>
  Math.min(1, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / Math.max(1, width * height)));

function wrapped(context: Context, text: string, width: number) {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/(?<=\s)/)) {
      if (line && context.measureText(line + word).width > width) {
        lines.push(line.trimEnd());
        line = "";
      }
      line += word;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function drawText(context: Context, text: string, r: Rect, size: number) {
  context.font = `${size}px ${FONT}`;
  context.textBaseline = "top";
  const height = size * 1.25;
  wrapped(context, text, r.width).forEach((line, index) => {
    const y = r.y + index * height;
    if (y < r.y + r.height) context.fillText(line, r.x, y);
  });
}

function drawStroke(context: Context, item: EaselItem, r: Rect, width: number) {
  const relative = itemPoints(item);
  const points = (
    relative.length
      ? relative
      : [
          { x: 0, y: 0 },
          { x: r.width, y: r.height },
        ]
  ).map((p) => ({ x: r.x + p.x, y: r.y + p.y }));
  const first = points[0]!;
  context.beginPath();
  context.moveTo(first.x, first.y);
  if (points.length === 1) context.lineTo(first.x + 0.1, first.y);
  for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  context.stroke();
  if (item.kind !== "arrow" || points.length < 2) return;
  const last = points[points.length - 1]!;
  const before = points[points.length - 2]!;
  const angle = Math.atan2(last.y - before.y, last.x - before.x);
  const length = Math.max(12, width * 4);
  context.beginPath();
  for (const offset of [-0.5, 0.5]) {
    context.moveTo(last.x, last.y);
    context.lineTo(last.x - Math.cos(angle + offset) * length, last.y - Math.sin(angle + offset) * length);
  }
  context.stroke();
}

export function drawItem(context: Context, item: EaselItem, images: EaselImages) {
  const r = itemRect(item);
  const color = item.color ?? "#222222";
  const width = Math.max(0.5, item.lineWidth ?? 2);
  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = width;
  context.lineCap = "round";
  context.lineJoin = "round";
  switch (item.kind) {
    case "image": {
      const image = item.path ? images(item.path) : null;
      if (image) context.drawImage(image, r.x, r.y, r.width, r.height);
      else {
        context.fillStyle = "#EDEDED";
        context.fillRect(r.x, r.y, r.width, r.height);
        context.fillStyle = "#777777";
        drawText(context, item.live ? "Live clip" : "Image unavailable", { x: r.x + 12, y: r.y + 12, width: r.width - 24, height: r.height - 24 }, 14);
      }
      break;
    }
    case "text":
    case "link": {
      const link = item.kind === "link";
      if (link) {
        context.save();
        context.globalAlpha = 0.08;
        context.fillRect(r.x, r.y, r.width, r.height);
        context.restore();
        context.strokeRect(r.x, r.y, r.width, r.height);
      }
      context.beginPath();
      context.rect(r.x, r.y, r.width, r.height);
      context.clip();
      const area = link ? { x: r.x + 12, y: r.y + 12, width: r.width - 24, height: r.height - 24 } : r;
      drawText(context, item.text ?? item.url ?? "", area, Math.max(1, item.fontSize ?? (link ? 16 : 24)));
      break;
    }
    case "rect":
      context.strokeRect(r.x, r.y, r.width, r.height);
      break;
    case "ellipse":
      context.beginPath();
      context.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2, 0, 0, 2 * Math.PI);
      context.stroke();
      break;
    case "pen":
    case "arrow":
      drawStroke(context, item, r, width);
      break;
  }
  context.restore();
}

/** Every item on its background, at most what a canvas can hold; null when there's nothing to draw. */
export function renderEasel(document: EaselDocument, images: EaselImages) {
  const bounds = contentBounds(document.items);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
  const scale = boundedScale(bounds.width, bounds.height);
  const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(bounds.width * scale)), Math.max(1, Math.ceil(bounds.height * scale)));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.scale(scale, scale);
  context.translate(-bounds.x, -bounds.y);
  context.fillStyle = document.background;
  context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
  for (const item of document.items) drawItem(context, item, images);
  return canvas;
}
