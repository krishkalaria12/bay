import { ELEMENT_INFO } from "@bay/core/src/elementInfo.ts";

// Inspect: the picker (picker.ts) selects an element; this reads what it is with the code desktop's Developer Mode
// inspector uses, and which font renders its text.

export interface InspectedRule {
  selector: string;
  source: string;
  decls: [string, string][];
}

export interface InspectedFont {
  /** The font-family stack as written. */
  stack: string[];
  /** The family that draws the text: a web font, an installed font, or the generic fallback. */
  rendered: string;
  web: boolean;
  /** Where the web font is loaded from, when the page's style sheets say. */
  source: string | null;
  size: string;
  weight: string;
  style: string;
  lineHeight: string;
  letterSpacing: string;
  color: string;
}

export interface InspectedElement {
  name: string;
  selector: string;
  width: number;
  height: number;
  x: number;
  y: number;
  color: string;
  background: string;
  /** The two colours above in sRGB for the app to draw: pages can write any CSS colour, such as oklch(). */
  swatches: { color: string; background: string };
  rules: InspectedRule[];
  font: InspectedFont;
  /** The element's text, shortened; "" when it has none. */
  text: string;
  /** Everything above as Markdown for a coding agent. */
  agent: string;
}

/** Describes the element the picker selected; resolves `InspectedElement`, or null when nothing is selected. */
export const INSPECT_SCRIPT = `
${ELEMENT_INFO}
const picker = window[Symbol.for("bay.picker")];
const el = picker && picker.current;
if (!el || !el.isConnected) return null;
const info = describe(el);
// Painting a colour and reading the pixel back turns any CSS colour into sRGB.
const pixel = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
const srgb = (value) => {
  if (!pixel) return value;
  pixel.clearRect(0, 0, 1, 1);
  pixel.fillStyle = "#0000";
  pixel.fillStyle = value;
  pixel.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = pixel.getImageData(0, 0, 1, 1).data;
  return "rgba(" + r + ", " + g + ", " + b + ", " + Math.round((a / 255) * 100) / 100 + ")";
};
const text = (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ");
return {
  name: info.name,
  selector: selectorOf(el),
  width: info.width,
  height: info.height,
  x: info.x,
  y: info.y,
  color: info.color,
  background: info.background,
  swatches: { color: srgb(info.color), background: srgb(info.background) },
  rules: info.rules,
  font: fontOf(el),
  text: text.length > 200 ? text.slice(0, 200) + "…" : text,
  agent: forAgent(el),
};
`;
