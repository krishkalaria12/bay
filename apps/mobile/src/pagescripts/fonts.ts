import { withArgs } from "./args.ts";

/**
 * Shows the page in one of Bay's fonts (`args.family`, a CSS font-family; empty puts the site's own back). The font's
 * files come in `args.faces` as base64 woff2 with their style and weight, and go in through the FontFace API, which
 * fetches nothing, so a site's font-src policy can't block them. Code, keyboard keys, maths, SVG and icon fonts keep
 * their own. Safe to run more than once per page: each file is added once, and the rule is replaced.
 */
export const PAGE_FONT_SCRIPT = `
const state = (window[Symbol.for("bay.font")] ??= { added: new Set() });
let style = document.getElementById("bay-site-font");
if (!args.family) {
  style?.remove();
  return "ok";
}
const name = /^"([^"]+)"/.exec(args.family);
for (const face of args.faces || []) {
  const key = (name ? name[1] : "") + " " + face.weight + (face.italic ? " italic" : "");
  if (!name || state.added.has(key)) continue;
  const bytes = Uint8Array.from(atob(face.data), (char) => char.charCodeAt(0));
  const font = new FontFace(name[1], bytes, { style: face.italic ? "italic" : "normal", weight: face.weight, display: "swap" });
  document.fonts.add(font);
  state.added.add(key);
}
if (!style) {
  style = document.createElement("style");
  style.id = "bay-site-font";
  (document.head || document.documentElement).append(style);
}
// :where keeps the rule's weight at nothing, so only !important lifts it over the page's own.
const keep = 'code, pre, pre *, kbd, samp, tt, var, math, math *, svg, svg *, i:empty, [class*="icon" i], [class*="fa-"], [class*="material-"], [class*="glyph" i], [class*="symbol" i], [aria-hidden="true"]:empty';
style.textContent = ":where(html, body, body *:not(" + keep + ")) { font-family: " + args.family + " !important; }";
return "ok";
`;

export function pageFontScript({ family, faces }: { family: string; faces: readonly { data: string; italic: boolean; weight: string }[] }): string {
  return withArgs(PAGE_FONT_SCRIPT, { family, faces });
}

/**
 * Forced dark for an engine without its own (WebKit): with `args.on`, a page that isn't dark already (the app asks it
 * for its dark look first) has its colours inverted, and images, video and canvas turned back. `args.on` false puts the
 * page back. Safe to run more than once per page.
 */
export const FORCE_DARK_SCRIPT = `
let style = document.getElementById("bay-force-dark");
if (!args.on) {
  style?.remove();
  return "off";
}
const parse = (value) => {
  const m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?/.exec(value || "");
  return m && (m[4] === undefined || Number(m[4]) > 0.5) ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
if (!style) {
  const body = document.body && parse(getComputedStyle(document.body).backgroundColor);
  const color = body || parse(getComputedStyle(document.documentElement).backgroundColor) || [255, 255, 255];
  const light = (0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]) / 255;
  // Dark already, from its own dark look or by design.
  if (light < 0.4) return "dark";
  style = document.createElement("style");
  style.id = "bay-force-dark";
  (document.head || document.documentElement).append(style);
}
const back = "img, video, canvas, picture, iframe, embed, object, svg image, [style*='background-image']";
style.textContent =
  "html { filter: invert(1) hue-rotate(180deg) !important; background: #fff !important; }" +
  back + " { filter: invert(1) hue-rotate(180deg) !important; }" +
  ":is(" + back + ") :is(" + back + ") { filter: none !important; }";
return "inverted";
`;

export function forceDarkScript({ on }: { on: boolean }): string {
  return withArgs(FORCE_DARK_SCRIPT, { on });
}
