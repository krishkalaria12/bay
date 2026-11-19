import { withArgs } from "./args.ts";

/** Bay's page zoom (`args.textSize`), and AMP pages swapped for the publisher's own (`args.skipAmp`). Safe to run more than once per page. */
export const PAGE_TWEAKS_SCRIPT = `
const root = document.documentElement;
if (args.skipAmp && (root.hasAttribute("amp") || root.hasAttribute("⚡"))) {
  const canonical = document.querySelector('link[rel="canonical"]');
  const href = canonical && canonical.href;
  // Never from https down to http.
  const safe = location.protocol === "https:" ? /^https:/.test(href || "") : /^https?:/.test(href || "");
  if (safe && href.split("#")[0] !== location.href.split("#")[0]) {
    location.replace(href);
    return "amp";
  }
}
const size = args.textSize;
const state = (window[Symbol.for("bay.tweaks")] ??= {});
// CSS zoom scales text and images and reflows the page, the same on both engines.
// It goes on <body>: Reader and the element picker attach to <html> and keep their own sizes.
// ponytail: a page using 100vw widths can overflow sideways when zoomed; native page zoom (Chromium's zoom level,
// WKWebView.pageZoom) is the upgrade if that shows up.
if (document.body && (size !== 100 || state.size)) {
  document.body.style.setProperty("zoom", size === 100 ? "" : String(size / 100));
  state.size = size !== 100;
}
return "ok";
`;

export function pageTweaksScript({ textSize, skipAmp }: { textSize: number; skipAmp: boolean }): string {
  return withArgs(PAGE_TWEAKS_SCRIPT, { textSize, skipAmp });
}

/**
 * The colour at the top of the page, for the strip behind the status bar: the background under the top edge, else
 * the page's theme-color, else its body, else the browser's canvas the page shows through (light or dark, as the page's
 * colour scheme says). With `args.edge` "bottom" (the native apps), the colour along the bottom edge instead, for what
 * sits behind Bay's bar; theme-color describes a page's top, so it's skipped there. Resolves to [r, g, b].
 */
// ponytail: read once per load, so a header that changes colour on scroll keeps the first one; re-read on scroll if
// that shows up.
export const PAGE_COLOR_SCRIPT = `
const parse = (value) => {
  const m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?/.exec(value || "");
  return m && (m[4] === undefined || Number(m[4]) > 0.9) ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const bottom = typeof args !== "undefined" && args.edge === "bottom";
let element = document.elementFromPoint(innerWidth / 2, bottom ? innerHeight - 1 : 1);
while (element) {
  const color = parse(getComputedStyle(element).backgroundColor);
  if (color) return color;
  element = element.parentElement;
}
for (const meta of bottom ? [] : document.querySelectorAll('meta[name="theme-color"]')) {
  const media = meta.getAttribute("media");
  if (media && !matchMedia(media).matches) continue;
  const probe = document.createElement("i");
  probe.style.color = meta.content;
  if (!probe.style.color) continue;
  document.documentElement.append(probe);
  const color = parse(getComputedStyle(probe).color);
  probe.remove();
  if (color) return color;
}
const page = parse(getComputedStyle(document.body || document.documentElement).backgroundColor);
if (page) return page;
const canvas = document.createElement("i");
canvas.style.backgroundColor = "Canvas";
document.documentElement.append(canvas);
const color = parse(getComputedStyle(canvas).backgroundColor);
canvas.remove();
return color;
`;
