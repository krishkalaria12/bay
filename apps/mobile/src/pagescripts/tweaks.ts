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
