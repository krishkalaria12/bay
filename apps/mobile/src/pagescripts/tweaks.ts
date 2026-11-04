/** Bay's page zoom, and AMP pages swapped for the publisher's own. Safe to run more than once per page. */
export function pageTweaksScript({ textSize, skipAmp }: { textSize: number; skipAmp: boolean }): string {
  return `
const root = document.documentElement;
if (${skipAmp} && (root.hasAttribute("amp") || root.hasAttribute("⚡"))) {
  const canonical = document.querySelector('link[rel="canonical"]');
  const href = canonical && canonical.href;
  // Never from https down to http.
  const safe = location.protocol === "https:" ? /^https:/.test(href || "") : /^https?:/.test(href || "");
  if (safe && href.split("#")[0] !== location.href.split("#")[0]) {
    location.replace(href);
    return "amp";
  }
}
const size = ${textSize};
const state = (window[Symbol.for("bay.tweaks")] ??= {});
// CSS zoom scales text and images and reflows the page, on both engines. Android's WebView ignores text-size-adjust.
// It goes on <body>: Reader and the element picker attach to <html> and keep their own sizes.
// ponytail: a page using 100vw widths can overflow sideways when zoomed; native page zoom (WebSettings.textZoom,
// WKWebView.pageZoom) is the upgrade if that shows up.
if (document.body && (size !== 100 || state.size)) {
  document.body.style.setProperty("zoom", size === 100 ? "" : String(size / 100));
  state.size = size !== 100;
}
return "ok";
`;
}

/**
 * The colour at the top of the page, for the strip behind the status bar: the background under the top edge, else
 * the page's theme-color, else its body. Resolves to [r, g, b], or null when the page has no opaque colour there.
 */
// ponytail: read once per load, so a header that changes colour on scroll keeps the first one; re-read on scroll if
// that shows up.
export const PAGE_COLOR_SCRIPT = `
const parse = (value) => {
  const m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?/.exec(value || "");
  return m && (m[4] === undefined || Number(m[4]) > 0.9) ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
let element = document.elementFromPoint(innerWidth / 2, 1);
while (element) {
  const color = parse(getComputedStyle(element).backgroundColor);
  if (color) return color;
  element = element.parentElement;
}
for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
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
return parse(getComputedStyle(document.body || document.documentElement).backgroundColor);
`;
