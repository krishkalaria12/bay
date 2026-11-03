import { SELECTOR_FOR } from "@bay/core/src/selectorFor.ts";

// Hide elements: while editing, a tap on the page picks the element under it instead of acting; it's outlined, and the
// app gets `{ type: "picked", selector, label }` through post(). "Parent" widens the pick. Hidden elements are one
// style sheet the app rebuilds from the site's rules. State lives under Symbol.for("bay.picker").

export interface PickedElement {
  type: "picked";
  selector: string;
  /** What it is, in words: its kind and its text (Link “Pricing”). */
  label: string;
  /** Its tag, as <a>. */
  tag: string;
  width: number;
  height: number;
}

const PICKER = `
const state = (window[Symbol.for("bay.picker")] ??= {});
${SELECTOR_FOR}
const KINDS = { a: "Link", button: "Button", img: "Image", picture: "Image", svg: "Icon", video: "Video", audio: "Audio",
  iframe: "Embedded page", input: "Field", textarea: "Text field", select: "Menu", h1: "Heading", h2: "Heading", h3: "Heading",
  h4: "Heading", h5: "Heading", h6: "Heading", p: "Paragraph", ul: "List", ol: "List", li: "List item", nav: "Navigation",
  header: "Header", footer: "Footer", aside: "Sidebar", form: "Form", table: "Table", section: "Section", article: "Article",
  main: "Main content", label: "Label", figure: "Figure", blockquote: "Quote", code: "Code", pre: "Code block", dialog: "Dialog" };
const ROLES = { button: "Button", link: "Link", dialog: "Dialog", navigation: "Navigation", img: "Image", heading: "Heading", menu: "Menu", tab: "Tab" };
// "Link “Pricing”": its role or tag in words, and the words a person sees or hears for it.
const describe = (el) => {
  const tag = el.tagName.toLowerCase();
  const kind = ROLES[el.getAttribute("role")] || KINDS[tag] || (el.children.length ? "Block" : "Text");
  const words = (el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("placeholder") || el.textContent || "")
    .replace(/\\s+/g, " ")
    .trim();
  return words ? kind + " “" + (words.length > 48 ? words.slice(0, 47) + "…" : words) + "”" : kind;
};
const outline = () => {
  if (!state.box) {
    state.host = document.createElement("bay-picker");
    state.host.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;display:block;";
    const root = state.host.attachShadow({ mode: "closed" });
    state.box = document.createElement("div");
    state.box.style.cssText = "position:fixed;border:2px solid #FF453A;background:rgba(255,69,58,.12);border-radius:4px;box-sizing:border-box;pointer-events:none;transition:all .12s ease;";
    root.append(state.box);
    document.documentElement.append(state.host);
  }
  const el = state.current;
  if (!el || !el.isConnected) {
    state.box.style.display = "none";
    return;
  }
  const rect = el.getBoundingClientRect();
  state.box.style.display = "block";
  state.box.style.left = rect.left + "px";
  state.box.style.top = rect.top + "px";
  state.box.style.width = rect.width + "px";
  state.box.style.height = rect.height + "px";
};
const pick = (el) => {
  state.current = el;
  outline();
  const selector = selectorFor(el, 0);
  const rect = el.getBoundingClientRect();
  if (selector) post({ type: "picked", selector, label: describe(el), tag: "<" + el.tagName.toLowerCase() + ">", width: Math.round(rect.width), height: Math.round(rect.height) });
};
`;

export const START_PICKER_SCRIPT = `
${PICKER}
if (state.active) return true;
state.active = true;
// Don't cancel pointerdown: doing so suppresses the compatibility click on touch devices. Touch taps are picked
// at touchend, while a moved touch keeps its native scrolling behavior and never picks the element under its end.
state.touch = null;
state.lastTouch = 0;
state.onTap = (event) => {
  event.stopPropagation();
  event.stopImmediatePropagation();
  if (event.type === "touchstart") {
    const point = event.touches[0];
    state.touch = point && event.touches.length === 1 ? { x: point.clientX, y: point.clientY, moved: false } : null;
    return;
  }
  if (event.type === "touchmove") {
    const point = event.touches[0];
    if (state.touch && point && (event.touches.length !== 1 || Math.hypot(point.clientX - state.touch.x, point.clientY - state.touch.y) > 10)) state.touch.moved = true;
    return;
  }
  if (event.type === "touchcancel") { state.touch = null; return; }
  let point = event;
  if (event.type === "touchend") {
    const touch = state.touch;
    state.touch = null;
    state.lastTouch = Date.now();
    if (!touch || touch.moved || event.touches.length) return;
    point = event.changedTouches[0];
    event.preventDefault();
  } else if (event.type === "click") {
    event.preventDefault();
    if (Date.now() - state.lastTouch < 700) return;
  } else return;
  if (!point) return;
  const el = document.elementFromPoint(point.clientX, point.clientY);
  if (el && el !== document.documentElement && el !== document.body) pick(el);
};
state.onScroll = () => outline();
state.onResize = () => outline();
state.events = ["click", "pointerdown", "pointerup", "touchstart", "touchmove", "touchend", "touchcancel", "mousedown", "mouseup"];
for (const type of state.events) window.addEventListener(type, state.onTap, { capture: true, passive: false });
window.addEventListener("scroll", state.onScroll, true);
window.addEventListener("resize", state.onResize);
state.pick = pick;
// Add the (hidden) outline layer now: WebKit only starts sending touches to new listeners after the page next
// renders, so on a still page the first taps would never reach them.
state.current = null;
outline();
return true;
`;

/** Widens the pick to the parent element; resolves false when there is none worth hiding. */
export const PICK_PARENT_SCRIPT = `
const state = window[Symbol.for("bay.picker")];
const parent = state && state.current && state.current.parentElement;
if (!parent || parent === document.body || parent === document.documentElement) return false;
state.pick(parent);
return true;
`;

export const STOP_PICKER_SCRIPT = `
const state = window[Symbol.for("bay.picker")];
if (!state || !state.active) return true;
for (const type of state.events) window.removeEventListener(type, state.onTap, true);
window.removeEventListener("scroll", state.onScroll, true);
window.removeEventListener("resize", state.onResize);
if (state.host) state.host.remove();
state.active = false;
state.host = state.box = state.current = state.touch = state.pick = null;
return true;
`;

/** Replaces the page's hidden elements with `selectors`; resolves how many elements they hide now. */
export function hideElementsScript(selectors: readonly string[]): string {
  return `
const SELECTORS = ${JSON.stringify(selectors)};
const state = (window[Symbol.for("bay.hidden")] ??= {});
if (!state.style || !state.style.isConnected) {
  state.style = document.createElement("style");
  state.style.setAttribute("data-bay-hidden", "");
  (document.head || document.documentElement).append(state.style);
}
const valid = SELECTORS.filter((s) => { try { document.querySelector(s); return true; } catch (e) { return false; } });
state.style.textContent = valid.map((s) => s + "{display:none!important}").join("\\n");
const picker = window[Symbol.for("bay.picker")];
if (picker && picker.box) picker.box.style.display = "none";
return valid.reduce((count, s) => count + document.querySelectorAll(s).length, 0);
`;
}
