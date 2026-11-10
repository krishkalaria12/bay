// Find on page: matches in the page's visible text are highlighted with the CSS Custom Highlight API, which marks
// ranges without changing the page's DOM, through a constructed style sheet (a page's Content Security Policy can't
// block one). Engines without highlights select the current match instead. Matching ignores case and stays within one
// text node. State lives under Symbol.for("bay.find").

/** At most this many matches are marked, so a huge page stays responsive. */
export const MAX_MATCHES = 1000;

export interface FindResult {
  /** Matches on the page (at most MAX_MATCHES). */
  count: number;
  /** The current match, from 0; -1 when there are none. */
  index: number;
}

const HELPERS = `
const state = (window[Symbol.for("bay.find")] ??= {});
const highlights = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function";
const show = () => {
  const current = state.ranges[state.index];
  if (highlights) {
    if (!state.sheet) {
      state.sheet = new CSSStyleSheet();
      state.sheet.replaceSync("::highlight(bay-find){background-color:#FFE066;color:#1C1C1E}::highlight(bay-find-current){background-color:#FF9F0A;color:#1C1C1E}");
    }
    if (!document.adoptedStyleSheets.includes(state.sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, state.sheet];
    CSS.highlights.set("bay-find", new Highlight(...state.ranges));
    CSS.highlights.set("bay-find-current", current ? new Highlight(current) : new Highlight());
  } else if (current) {
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(current);
  }
  if (current) {
    const rect = current.getBoundingClientRect();
    if (rect.top < innerHeight * 0.15 || rect.bottom > innerHeight * 0.6) {
      scrollBy({ top: rect.top - innerHeight * 0.3, behavior: "instant" });
    }
  }
  return { count: state.ranges.length, index: current ? state.index : -1 };
};
const clear = () => {
  if (highlights) {
    CSS.highlights.delete("bay-find");
    CSS.highlights.delete("bay-find-current");
  }
  if (state.sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== state.sheet);
  if (!highlights && state.ranges && state.ranges.length) getSelection().removeAllRanges();
  state.ranges = [];
  state.index = 0;
};
`;

/** Marks every match of `query` and scrolls to the first one at or below the top of the screen. */
export function findScript(query: string): string {
  return `
const QUERY = ${JSON.stringify(query)};
${HELPERS}
clear();
const needle = QUERY.toLocaleLowerCase();
if (!needle.trim()) return { count: 0, index: -1 };
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "SELECT", "OPTION"]);
const hidden = new Map();
const isHidden = (element) => {
  if (!element) return false;
  if (hidden.has(element)) return hidden.get(element);
  const style = getComputedStyle(element);
  const result = SKIP.has(element.tagName.toUpperCase()) || style.display === "none" || style.visibility === "hidden" || isHidden(element.parentElement);
  hidden.set(element, result);
  return result;
};
const ranges = [];
const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
for (let node = walker.nextNode(); node && ranges.length < ${MAX_MATCHES}; node = walker.nextNode()) {
  const text = node.nodeValue.toLocaleLowerCase();
  let at = text.indexOf(needle);
  if (at < 0 || isHidden(node.parentElement)) continue;
  while (at >= 0 && ranges.length < ${MAX_MATCHES}) {
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + needle.length);
    ranges.push(range);
    at = text.indexOf(needle, at + needle.length);
  }
}
state.ranges = ranges;
const first = ranges.findIndex((range) => range.getBoundingClientRect().bottom >= 0);
state.index = first < 0 ? 0 : first;
return show();
`;
}

/** Moves to the next (1) or previous (-1) match, wrapping around. */
export function findStepScript(step: 1 | -1): string {
  return `
${HELPERS}
if (!state.ranges || !state.ranges.length) return { count: 0, index: -1 };
state.index = (state.index + ${step} + state.ranges.length) % state.ranges.length;
return show();
`;
}

/** Removes the marks. */
export const FIND_CLEAR_SCRIPT = `
${HELPERS}
clear();
return true;
`;
