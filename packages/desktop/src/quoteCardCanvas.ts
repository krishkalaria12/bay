import type { QuoteCard } from "./screenCapture";

const WIDTH = 720;
const MARGIN = 64;
const TEXT_WIDTH = WIDTH - MARGIN * 2;
const MAX_TEXT_HEIGHT = 6000;
const FONT = 'system-ui, -apple-system, "Segoe UI", Ubuntu, sans-serif';
type Context = OffscreenCanvasRenderingContext2D;

// Keep a line's shaping together when measuring and drawing, and break long
// words at grapheme boundaries so emoji and combining marks stay intact.
export function quoteLines(context: Pick<Context, "measureText">, text: string, width: number): string[] {
  const lines: string[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const paragraph of text.split(/\r\n|[\n\r]/)) {
    let line = "";
    for (const word of paragraph.split(/(?<=\s)/u)) {
      if (line && context.measureText(line + word).width > width) {
        lines.push(line.trimEnd());
        line = "";
      }
      for (const { segment } of segmenter.segment(word)) {
        if (line && context.measureText(line + segment).width > width) {
          lines.push(line.trimEnd());
          line = "";
        }
        line += segment;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function sourceURL(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.hostname ? url : null;
  } catch {
    return null;
  }
}

function truncate(context: Context, text: string, width: number) {
  if (context.measureText(text).width <= width) return text;
  const letters = Array.from(text);
  while (letters.length && context.measureText(letters.join("") + "…").width > width) letters.pop();
  return letters.length < Array.from(text).length ? letters.join("") + "…" : text;
}

/** QuoteCard.swift's local card, rendered at 2x on the desktop web host. */
export function renderQuoteCard({ text, title, url, colors, dark }: QuoteCard): OffscreenCanvas | null {
  const quote = text.trim();
  const source = sourceURL(url);
  const length = Array.from(quote).length;
  if (!length || length > 4000 || !source) return null;
  const size = length <= 220 ? 34 : length <= 700 ? 28 : 24;
  const canvas = new OffscreenCanvas(WIDTH * 2, 2);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.font = `500 ${size}px ${FONT}`;
  const lines = quoteLines(context, quote, TEXT_WIDTH);
  const lineHeight = size * 1.25 + 6;
  const quoteHeight = lines.length * lineHeight;
  if (quoteHeight > MAX_TEXT_HEIGHT) return null;
  const footerTop = 100 + quoteHeight + 32;
  const height = footerTop + 102;
  canvas.height = Math.ceil(height * 2);
  context.scale(2, 2);
  context.textBaseline = "top";
  const ink = dark ? "#ffffff" : "#141414";
  const secondary = dark ? "rgba(255,255,255,0.6)" : "rgba(20,20,20,0.6)";
  const stops = colors.slice(0, 8).filter((color) => /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(color));
  if (!stops.length) stops.push(dark ? "#383838" : "#d9d9d9");
  if (stops.length === 1) stops.push(stops[0]!);
  const gradient = context.createLinearGradient(0, 0, WIDTH, height);
  stops.forEach((color, i) => gradient.addColorStop(i / (stops.length - 1), color));
  context.fillStyle = gradient;
  context.fillRect(0, 0, WIDTH, height);
  context.beginPath();
  context.roundRect(24, 24, WIDTH - 48, height - 48, 20);
  context.fillStyle = dark ? "rgba(20,20,20,0.94)" : "rgba(255,255,255,0.94)";
  context.fill();
  context.strokeStyle = dark ? "rgba(255,255,255,0.1)" : "rgba(20,20,20,0.1)";
  context.stroke();
  context.font = `600 58px ${FONT}`;
  context.fillStyle = secondary;
  context.fillText("“", MARGIN - 3, 39);
  context.font = `500 ${size}px ${FONT}`;
  context.fillStyle = ink;
  const letter = quote.match(/\p{Letter}/u)?.[0] ?? "";
  const rtl = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/u.test(letter);
  context.direction = rtl ? "rtl" : "ltr";
  context.textAlign = rtl ? "right" : "left";
  lines.forEach((line, index) => context.fillText(line, rtl ? WIDTH - MARGIN : MARGIN, 100 + index * lineHeight));
  context.direction = "ltr";
  context.textAlign = "left";
  context.font = `600 16px ${FONT}`;
  const name =
    title
      .trim()
      .replace(/[\r\n]+/g, " ")
      .slice(0, 1000) || source.hostname;
  context.fillText(truncate(context, name, TEXT_WIDTH), MARGIN, footerTop);
  context.font = `14px ${FONT}`;
  context.fillStyle = secondary;
  context.fillText(truncate(context, source.hostname, TEXT_WIDTH - 50), MARGIN, footerTop + 29);
  context.font = `600 14px ${FONT}`;
  context.fillText("Bay", WIDTH - MARGIN - 32, footerTop + 29);
  return canvas;
}
