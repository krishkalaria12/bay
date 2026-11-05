// Boosts' element picker, run in the page by evaluate (its main world, with `post` to answer and to message the app as
// "boost": state.ts › onBoostMessage), as Capture's is (capture/captureScript.ts). The element under the pointer is
// outlined; a click picks it.
//   zap:   a card offers "Zap This", "Zap Related" (move along it to take in more like it, as Arc's and Zen's) and
//          Cancel; each zap goes to the app, which hides it through the Boost's sheet. A bar says how to stop.
//   focus: the click keeps that element alone (Zen's Focus) and the picker leaves.
//   pick:  the selector for the code editor ("Insert Selector", or related), then the picker leaves.
// Its elements are in a closed shadow root the page's CSS and scripts can't reach; while it's on, presses go to it,
// not the page. Esc leaves. No template literals or backticks inside: this file's strings are one.
//
// The selector builder (selectorFor) is Zen Browser's (src/zen/boosts/ZenSelectorComponent.sys.mjs › getSelectionPath),
// under the Mozilla Public License 2.0: https://mozilla.org/MPL/2.0/.
export type PickerMode = "zap" | "focus" | "pick";

export function pickerScript(mode: PickerMode | null, pickerId: string | null = null): string {
  return `const MODE = ${mode ? JSON.stringify(mode) : "null"};\nconst PICKER_ID = ${JSON.stringify(pickerId)};\n${SELECTOR_FOR}\n${PICKER}`;
}

/** Shows the elements a zap hides, outlined, while its row in the editor is hovered; null selector stops. */
export function previewScript(selector: string | null): string {
  return `const SELECTOR = ${JSON.stringify(selector)};\n${PREVIEW}`;
}

/** How many elements each selector matches now: answers a JSON array of numbers (0 for one that doesn't parse). */
export function countScript(selectors: string[]): string {
  return `const SELECTORS = ${JSON.stringify(selectors)};
post("result", JSON.stringify(SELECTORS.map((s) => {
  try {
    return document.querySelectorAll(s).length;
  } catch (e) {
    return 0;
  }
})));`;
}

// Zen's getSelectionPath. related: 0 the element itself (the shortest of three candidate paths), 1 its parent, 2 its
// kind under the same parent, 3 its kind under parents of that kind, 4 its kind anywhere, 5 its parent's kind, 6
// everything under its parent, 7 elements with its classes.
const SELECTOR_FOR = String.raw`
const selectorFor = (element, related) => {
  const isValidNode = (el) => !!el && el.nodeType === 1 && !/^(body|html)$/i.test(el.tagName);
  const nthChild = (el) => {
    if (!el || !el.parentNode || !el.parentNode.children) return "";
    const parent = el.parentNode;
    const index = Array.prototype.indexOf.call(parent.children, el) + 1;
    if (index === 1) return ":first-child";
    if (index === parent.children.length) return ":last-child";
    return ":nth-child(" + index + ")";
  };
  const identify = (el, specificity) => {
    if (!el || el.nodeType !== 1) return "";
    const id = specificity < 2 && el.id ? "#" + CSS.escape(el.id) : "";
    const cls = specificity < 1 && el.classList.length ? "." + Array.from(el.classList).map((c) => CSS.escape(c)).join(".") : "";
    return el.tagName.toLowerCase() + id + cls;
  };
  const build = (parts) => parts.slice().reverse().join("");
  const count = (sel) => {
    try {
      return sel ? document.querySelectorAll(sel).length : 0;
    } catch (e) {
      return Infinity;
    }
  };
  const traverse = (el, specificity, parts) => {
    let current = el;
    if (!isValidNode(current)) return;
    parts.push(nthChild(current));
    parts.push(identify(current, specificity));
    if (current.parentNode && current.parentNode.nodeType === 1) {
      parts.push(" > ");
      parts.push(identify(current.parentNode, 0));
      let built = build(parts);
      while (built && count(built) > 1 && isValidNode(current.parentNode)) {
        current = current.parentNode;
        parts.push(" > ");
        parts.push(nthChild(current.parentNode));
        parts.push(identify(current.parentNode, 0));
        built = build(parts);
      }
    }
  };
  const bestExact = (el) => {
    const candidates = new Map();
    const exact = [];
    traverse(el, 0, exact);
    candidates.set(count(build(exact)), build(exact));
    const byType = [identify(el, 2)];
    if (isValidNode(el.parentNode)) {
      byType.push(" > ");
      traverse(el.parentNode, 0, byType);
    }
    const typeLength = count(build(byType));
    if (!candidates.has(typeLength)) candidates.set(typeLength, build(byType));
    let smallest = Infinity, best = null;
    candidates.forEach((sel, n) => {
      if (n >= 1 && n < smallest) {
        smallest = n;
        best = sel;
      }
    });
    return best || build(exact);
  };
  if (!isValidNode(element)) return null;
  const parts = [];
  switch (related) {
    case 1:
      if (!isValidNode(element.parentNode)) return null;
      traverse(element.parentNode, 0, parts);
      break;
    case 2:
      parts.push(identify(element, 2));
      if (isValidNode(element.parentNode)) {
        parts.push(" > ");
        parts.push(identify(element.parentNode, 0));
      }
      break;
    case 3:
      parts.push(identify(element, 2));
      if (isValidNode(element.parentNode)) {
        parts.push(" > ");
        parts.push(identify(element.parentNode, 2));
      }
      break;
    case 4:
      parts.push(identify(element, 2));
      break;
    case 5:
      if (!isValidNode(element.parentNode)) return null;
      parts.push(identify(element.parentNode, 2));
      break;
    case 6:
      if (!isValidNode(element.parentNode)) return null;
      parts.push("*");
      parts.push(" > ");
      traverse(element.parentNode, 0, parts);
      break;
    case 7:
      parts.push(identify(element, 1));
      break;
    default:
      return bestExact(element);
  }
  return build(parts) || null;
};`;

const PICKER = String.raw`
const KEY = Symbol.for("bay.boostPicker");
const installed = document[KEY];
if (typeof installed === "function") installed();
if (!MODE || !document.documentElement) {
  post("result", "true");
  return;
}
const send = (data) => post("boost", JSON.stringify({ ...data, pickerId: PICKER_ID }));
const RELATED_LEVELS = 8;
const ACCENT = MODE === "zap" ? "#FF5F57" : "#4F7BE8";

const host = document.createElement("bay-boost-picker");
host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; display: block; pointer-events: none;";
const shadow = host.attachShadow({ mode: "closed" });
shadow.innerHTML =
  "<style>" +
  ":host { all: initial; }" +
  "* { box-sizing: border-box; }" +
  ".hover, .lit { position: fixed; border-radius: 5px; pointer-events: none; }" +
  ".hover { display: none; outline: 2px solid " + ACCENT + "; background: " + ACCENT + "1F; transition: left 70ms ease-out, top 70ms ease-out, width 70ms ease-out, height 70ms ease-out; }" +
  ".lit { outline: 2px solid " + ACCENT + "; background: " + ACCENT + "33; }" +
  ".card, .bar { position: fixed; pointer-events: auto; background: rgba(28,28,30,0.94); color: rgba(255,255,255,0.94); box-shadow: 0 10px 30px rgba(0,0,0,0.32), inset 0 0 0 0.5px rgba(255,255,255,0.16); font: 500 12.5px/17px -apple-system, system-ui, sans-serif; cursor: default; }" +
  ".card { display: none; flex-direction: column; gap: 8px; padding: 9px; border-radius: 14px; min-width: 300px; max-width: min(460px, calc(100vw - 20px)); }" +
  ".card.on { display: flex; }" +
  ".row { display: flex; gap: 6px; }" +
  ".path { padding: 0 3px; font: 11px/15px ui-monospace, Menlo, monospace; color: rgba(255,255,255,0.62); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }" +
  ".path b { color: #fff; font-weight: 600; }" +
  "button { all: unset; position: relative; overflow: hidden; height: 28px; padding: 0 12px; border-radius: 9px; background: rgba(255,255,255,0.11); color: #fff; font: 500 12.5px/28px -apple-system, system-ui, sans-serif; text-align: center; white-space: nowrap; }" +
  "button:hover { background: rgba(255,255,255,0.19); }" +
  "button.main { background: " + ACCENT + "; }" +
  "button.main:hover { filter: brightness(1.1); }" +
  ".related { flex: 1; }" +
  ".related .fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: " + ACCENT + "66; pointer-events: none; }" +
  ".related span { position: relative; }" +
  ".bar { left: 50%; bottom: 18px; transform: translateX(-50%); display: flex; align-items: center; gap: 12px; padding: 7px 8px 7px 14px; border-radius: 13px; white-space: nowrap; }" +
  ".bar b { color: #fff; font-weight: 600; }" +
  "</style>" +
  "<div class='hover'></div><div class='lits'></div>" +
  "<div class='card'><div class='path'></div><div class='row'><button class='main this'></button><button class='related'><div class='fill'></div><span></span></button><button class='cancel'>Cancel</button></div></div>" +
  "<div class='bar'><span class='hint'></span><button class='done'></button></div>";
const $ = (s) => shadow.querySelector(s);
const hover = $(".hover"), lits = $(".lits"), card = $(".card"), path = $(".path"), bar = $(".bar");
const thisButton = $(".this"), relatedButton = $(".related"), relatedFill = $(".related .fill");
$(".related span").textContent = MODE === "pick" ? "Related" : "Zap Related";
thisButton.textContent = MODE === "pick" ? "Insert Selector" : "Zap This";
$(".done").textContent = MODE === "zap" ? "Done" : "Cancel";
$(".hint").innerHTML =
  MODE === "zap" ? "<b>Click</b> what to zap" : MODE === "focus" ? "<b>Click</b> what to keep: the rest is hidden" : "<b>Click</b> an element for its selector";

let pointed = null;
let chosen = null;
let related = 0;

const elementAt = (x, y) => {
  // Sheets and selectors apply to the document. A shadow host is the smallest target they can reach.
  const el = document.elementFromPoint(x, y);
  return el && el !== document.documentElement && el !== document.body ? el : null;
};
const place = (node, r, pad) => {
  node.style.left = r.left - pad + "px";
  node.style.top = r.top - pad + "px";
  node.style.width = r.width + 2 * pad + "px";
  node.style.height = r.height + 2 * pad + "px";
};
const selection = () => {
  const sel = chosen ? selectorFor(chosen, related) : null;
  if (!sel) return { sel: null, nodes: [] };
  try {
    const nodes = Array.from(document.querySelectorAll(sel));
    const target = related === 1 || related === 5 ? chosen.parentNode : chosen;
    return nodes.includes(target) ? { sel, nodes } : { sel: null, nodes: [] };
  } catch (e) {
    return { sel: null, nodes: [] };
  }
};
const drawHover = () => {
  if (chosen || !pointed || !pointed.isConnected) {
    hover.style.display = "none";
    return;
  }
  hover.style.display = "block";
  place(hover, pointed.getBoundingClientRect(), 3);
};
const drawChosen = () => {
  lits.textContent = "";
  if (!chosen) return;
  const { sel, nodes } = selection();
  for (const node of nodes.slice(0, 100)) {
    const box = document.createElement("div");
    box.className = "lit";
    place(box, node.getBoundingClientRect(), 3);
    lits.append(box);
  }
  path.innerHTML = "";
  const n = document.createElement("b");
  n.textContent = "[" + nodes.length + "] ";
  path.append(n, document.createTextNode(sel || ""));
  // Under the element, centred, kept on the screen.
  const r = chosen.getBoundingClientRect();
  const w = card.offsetWidth, h = card.offsetHeight;
  card.style.left = Math.max(10, Math.min(innerWidth - w - 10, (innerWidth - w) / 2)) + "px";
  card.style.top = Math.max(10, Math.min(innerHeight - h - 70, r.bottom + 10)) + "px";
};
const choose = (el) => {
  chosen = el;
  related = 0;
  relatedFill.style.width = "0";
  card.classList.toggle("on", !!el);
  drawHover();
  drawChosen();
};
const fades = new Map();
const cancelFade = (node) => {
  const fade = fades.get(node);
  if (!fade) return;
  clearTimeout(fade.timer);
  fade.animation.cancel();
  fades.delete(node);
};
const take = () => {
  const { sel, nodes } = selection();
  if (!sel) return;
  // Commit before Done, Escape, or another picker can stop this one.
  send({ type: "select", mode: MODE, selector: sel });
  if (MODE === "zap") {
    // A quick fade before the Boost's sheet hides them (Zen's dissolve, briefly).
    for (const node of nodes.slice(0, 50)) {
      cancelFade(node);
      const animation = node.animate([{ opacity: 0 }], { duration: 140, easing: "ease-out", fill: "forwards" });
      fades.set(node, { animation, timer: setTimeout(() => cancelFade(node), 540) });
    }
    choose(null);
    return;
  }
  uninstall();
};

// Ours: the card and the bar (events from inside a closed shadow root reach out here as the host).
const ours = (e) => e.target === host;
const listeners = [];
const listen = (type, fn, options) => {
  addEventListener(type, fn, options);
  listeners.push([type, fn, options]);
};
const swallow = (e) => {
  e.preventDefault();
  e.stopImmediatePropagation();
};

thisButton.addEventListener("click", take);
relatedButton.addEventListener("click", take);
relatedButton.addEventListener("mousemove", (e) => {
  const r = relatedButton.getBoundingClientRect();
  const v = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  relatedFill.style.width = v * 100 + "%";
  const next = Math.min(RELATED_LEVELS - 1, Math.round(v * (RELATED_LEVELS - 1)));
  if (next !== related) {
    related = next;
    drawChosen();
  }
});
relatedButton.addEventListener("mouseleave", () => {
  relatedFill.style.width = "0";
  if (related !== 0) {
    related = 0;
    drawChosen();
  }
});
$(".cancel").addEventListener("click", () => choose(null));
$(".done").addEventListener("click", () => {
  uninstall();
  send({ type: "done", mode: MODE });
});

listen("mousemove", (e) => {
  if (!e.isTrusted || ours(e)) return;
  e.stopImmediatePropagation();
  const el = elementAt(e.clientX, e.clientY);
  if (el !== pointed) {
    pointed = el;
    drawHover();
  }
}, { capture: true });
listen("click", (e) => {
  if (!e.isTrusted || ours(e)) return;
  swallow(e);
  const el = elementAt(e.clientX, e.clientY);
  if (!el) return;
  if (MODE === "focus") {
    chosen = el;
    related = 0;
    return take();
  }
  choose(el);
}, { capture: true });
for (const type of ["mousedown", "mouseup", "dblclick", "auxclick", "contextmenu", "dragstart", "selectstart", "submit"])
  listen(type, (e) => {
    if (e.isTrusted && !ours(e)) swallow(e);
  }, { capture: true });
// Kept from the page, not cancelled: a cancelled pointerdown has Chrome skip the mousedown and mouseup after it.
for (const type of ["pointerdown", "pointerup", "pointermove", "pointerover", "pointerout", "mouseover", "mouseout"])
  listen(type, (e) => {
    if (e.isTrusted && !ours(e)) e.stopImmediatePropagation();
  }, { capture: true });
listen("keydown", (e) => {
  if (!e.isTrusted || e.key !== "Escape") return;
  swallow(e);
  if (chosen) return choose(null);
  uninstall();
  send({ type: "done", mode: MODE });
}, { capture: true });
const redraw = () => {
  drawHover();
  drawChosen();
};
listen("scroll", redraw, { capture: true, passive: true });
listen("resize", redraw, { passive: true });
listen("pagehide", () => uninstall(), {});

const uninstall = () => {
  for (const node of fades.keys()) cancelFade(node);
  for (const [type, fn, options] of listeners) removeEventListener(type, fn, options);
  listeners.length = 0;
  host.remove();
  if (document[KEY] === uninstall) delete document[KEY];
};
Object.defineProperty(document, KEY, { value: uninstall, configurable: true });
document.documentElement.append(host);
post("result", "true");`;

const PREVIEW = String.raw`
const KEY = Symbol.for("bay.boostPreview");
const previous = document[KEY];
if (typeof previous === "function") previous();
if (!SELECTOR || !document.documentElement) {
  post("result", "true");
  return;
}
let nodes = [];
try {
  nodes = Array.from(document.querySelectorAll(SELECTOR)).slice(0, 200);
} catch (e) {}
for (const node of nodes) node.setAttribute("data-bay-unzap", "");
const host = document.createElement("bay-boost-preview");
host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483646; display: block; pointer-events: none;";
const shadow = host.attachShadow({ mode: "closed" });
document.documentElement.append(host);
// Once the shown elements have their boxes.
requestAnimationFrame(() => {
  for (const node of nodes.slice(0, 100)) {
    const r = node.getBoundingClientRect();
    const box = document.createElement("div");
    box.style.cssText = "position: fixed; border-radius: 5px; outline: 2px dashed #FF5F57; background: #FF5F5726; left: " + (r.left - 3) + "px; top: " + (r.top - 3) + "px; width: " + (r.width + 6) + "px; height: " + (r.height + 6) + "px;";
    shadow.append(box);
  }
  if (nodes[0]) nodes[0].scrollIntoView({ block: "nearest", behavior: "smooth" });
});
const stop = () => {
  for (const node of nodes) node.removeAttribute("data-bay-unzap");
  host.remove();
  if (document[KEY] === stop) delete document[KEY];
};
Object.defineProperty(document, KEY, { value: stop, configurable: true });
post("result", "true");`;
