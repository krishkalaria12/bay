// Capture's selection, as Arc's: run in the page by evaluate (in its main world, with `post` to answer and to message
// the app as "capture": state.ts › onCaptureMessage). The page dims; the block under the pointer is lit, ready for a
// click to take it, and a drag takes any area instead (scrolling on while dragging reaches past the window). Esc
// leaves. What's chosen goes to the app in CSS px from the document's top-left, once the overlay has gone from the
// screen, for the engine to capture (NNCoreWebView captureImage). Its elements are in a closed shadow root the page's
// CSS and scripts can't reach; while it's on, presses go to it, not the page. `start` (a point in the viewport) begins
// with a drag from there: ⌘⇧ and a drag on the page (page_script.js › Capture). Running it with `on` false takes it
// away. No template literals or backticks inside: this file's string is one.
export function captureScript(on: boolean, start?: { x: number; y: number }): string {
  return `const ON = ${on ? "true" : "false"};
const START = ${start ? JSON.stringify({ x: Number(start.x) || 0, y: Number(start.y) || 0 }) : "null"};
${SCRIPT}`;
}

const SCRIPT = String.raw`
const KEY = Symbol.for("bay.capture");
const installed = document[KEY];
if (typeof installed === "function") installed();
if (!ON || !document.documentElement) {
  post("result", JSON.stringify(!ON));
  return;
}
const send = (data) => post("capture", JSON.stringify(data));
const SHADE = "rgba(0,0,0,0.42)";
// A drag shorter than this either way is a click.
const DRAG = 5;
const MIN_WIDTH = 24, MIN_HEIGHT = 16;

const host = document.createElement("bay-capture");
host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; display: block; cursor: crosshair; pointer-events: auto;";
const shadow = host.attachShadow({ mode: "closed" });
shadow.innerHTML =
  "<style>" +
  ":host { all: initial; }" +
  "* { box-sizing: border-box; }" +
  ".shade { position: fixed; inset: 0; background: " + SHADE + "; }" +
  ".hole { position: fixed; display: none; border-radius: 4px; box-shadow: 0 0 0 200vmax " + SHADE + "; outline: 1.5px solid rgba(255,255,255,0.95); outline-offset: 0; }" +
  ".hole.snap { transition: left 90ms ease-out, top 90ms ease-out, width 90ms ease-out, height 90ms ease-out; }" +
  ".size { position: fixed; display: none; padding: 3px 7px; border-radius: 6px; background: rgba(20,20,22,0.88); color: #fff; font: 600 11px/14px -apple-system, system-ui, sans-serif; font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: none; }" +
  ".hint { position: fixed; left: 50%; top: 14px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; padding: 7px 8px 7px 14px; border-radius: 12px; background: rgba(28,28,30,0.92); box-shadow: 0 8px 28px rgba(0,0,0,0.3), inset 0 0 0 0.5px rgba(255,255,255,0.14); color: rgba(255,255,255,0.92); font: 500 13px/18px -apple-system, system-ui, sans-serif; white-space: nowrap; cursor: default; transition: opacity 120ms; }" +
  ".hint.gone { opacity: 0; pointer-events: none; }" +
  ".hint b { font-weight: 600; color: #fff; }" +
  "button { all: unset; height: 22px; padding: 0 8px; border-radius: 7px; background: rgba(255,255,255,0.12); color: #fff; font: 500 12px/22px -apple-system, system-ui, sans-serif; cursor: default; }" +
  "button:hover { background: rgba(255,255,255,0.2); }" +
  "</style>" +
  "<div class='shade'></div><div class='hole'></div><div class='size'></div>" +
  "<div class='hint'><span><b>Click</b> to capture what's lit, or <b>drag</b> over an area</span><button class='full'>Full Page</button><button class='cancel'>Cancel</button></div>";
const $ = (selector) => shadow.querySelector(selector);
const shade = $(".shade"), hole = $(".hole"), size = $(".size"), hint = $(".hint");

// The drag's corners in document px, so scrolling while dragging grows it.
let drag = null;
let snapped = null;
let pointer = START ? { x: START.x, y: START.y } : null;
let queued = false;
if (START) drag = { x: START.x + scrollX, y: START.y + scrollY, moved: true };

// MARK: What's under the pointer

const parentOf = (el) => el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
const elementAt = (x, y) => {
  const all = document.elementsFromPoint(x, y);
  let el = null;
  for (const e of all) if (e !== host) { el = e; break; }
  while (el && el.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
};
const MEDIA = /^(IMG|VIDEO|CANVAS|SVG|PICTURE|IFRAME|EMBED|OBJECT|FIGURE|TABLE|PRE|BLOCKQUOTE|BUTTON|INPUT|TEXTAREA|SELECT)$/i;
// A block worth a picture: big enough, not inline text, and not the whole page.
const capturable = (el) => {
  if (!el || el.nodeType !== 1 || el === document.documentElement || el === document.body) return false;
  const r = el.getBoundingClientRect();
  if (r.width < MIN_WIDTH || r.height < MIN_HEIGHT) return false;
  if (r.width >= innerWidth * 0.98 && r.height >= innerHeight * 0.98) return false;
  if (MEDIA.test(el.tagName)) return true;
  const display = getComputedStyle(el).display;
  return display !== "inline" && display !== "contents" && display !== "none";
};
const snapAt = (x, y) => {
  for (let el = elementAt(x, y); el; el = parentOf(el)) if (capturable(el)) return el;
  return null;
};

// MARK: Drawing

const place = (node, r) => {
  node.style.left = r.left + "px";
  node.style.top = r.top + "px";
  node.style.width = Math.max(0, r.width) + "px";
  node.style.height = Math.max(0, r.height) + "px";
};
const dragRect = () => {
  const x2 = pointer.x + scrollX, y2 = pointer.y + scrollY;
  const left = Math.min(drag.x, x2), top = Math.min(drag.y, y2);
  return { left: left - scrollX, top: top - scrollY, width: Math.abs(x2 - drag.x), height: Math.abs(y2 - drag.y) };
};
const lit = () => {
  if (drag && pointer) return dragRect();
  if (snapped && snapped.isConnected) {
    const r = snapped.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  return null;
};
const draw = () => {
  queued = false;
  const r = lit();
  hint.classList.toggle("gone", !!drag);
  if (!r || r.width < 1 || r.height < 1) {
    shade.style.display = "block";
    hole.style.display = "none";
    size.style.display = "none";
    return;
  }
  shade.style.display = "none";
  hole.style.display = "block";
  hole.classList.toggle("snap", !drag);
  place(hole, r);
  size.textContent = Math.round(r.width) + " × " + Math.round(r.height);
  size.style.display = "block";
  const below = r.top + r.height + 8;
  size.style.left = Math.max(6, Math.min(innerWidth - size.offsetWidth - 6, r.left)) + "px";
  size.style.top = (below + 22 <= innerHeight ? below : Math.max(6, r.top + 6)) + "px";
};
const redraw = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(draw);
};

// MARK: Choosing

// The area in document px, kept inside the document; past the window when it reaches beyond it.
const chosen = (r) => {
  const doc = document.documentElement;
  const maxX = Math.max(doc.scrollWidth, innerWidth), maxY = Math.max(doc.scrollHeight, innerHeight);
  const x = Math.max(0, r.left + scrollX), y = Math.max(0, r.top + scrollY);
  const width = Math.min(maxX, r.left + scrollX + r.width) - x, height = Math.min(maxY, r.top + scrollY + r.height) - y;
  const beyond = y < scrollY || x < scrollX || y + height > scrollY + innerHeight || x + width > scrollX + innerWidth;
  return { x, y, width, height, beyond, left: x - scrollX, top: y - scrollY };
};
const finish = (r) => {
  const area = chosen(r);
  if (area.width < 2 || area.height < 2) return;
  uninstall();
  // Sent once the overlay is off the screen, so the picture is the page's own.
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      send({ type: "capture", ...area, viewportWidth: innerWidth, viewportHeight: innerHeight }),
    ),
  );
};
const cancel = () => {
  uninstall();
  send({ type: "cancel" });
};
// ⌥-click: Capture in Portrait instead.
const fullPage = (e) => {
  uninstall();
  send({ type: "fullPage", portrait: !!(e && e.altKey) });
};

// MARK: Input

// Over the hint's buttons (a closed shadow root hides its nodes from the event's path out here).
const ours = (e) => {
  if (drag || hint.classList.contains("gone")) return false;
  const r = hint.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
};
const listeners = [];
const listen = (type, fn, options) => {
  addEventListener(type, fn, options);
  listeners.push([type, fn, options]);
};
const swallow = (e) => {
  e.preventDefault();
  e.stopImmediatePropagation();
};

$(".cancel").addEventListener("click", cancel);
$(".full").addEventListener("click", fullPage);

listen("mousemove", (e) => {
  if (!e.isTrusted) return;
  pointer = { x: e.clientX, y: e.clientY };
  if (drag) {
    // The press ended before this script was in the page (a quick ⌘⇧-drag): it ends here.
    if (!e.buttons && START && drag.moved) {
      const r = dragRect();
      drag = null;
      if (r.width >= DRAG && r.height >= DRAG) return finish(r);
    } else if (!drag.moved && Math.max(Math.abs(e.clientX + scrollX - drag.x), Math.abs(e.clientY + scrollY - drag.y)) >= DRAG) drag.moved = true;
  } else if (!ours(e)) {
    snapped = snapAt(e.clientX, e.clientY);
  }
  if (!ours(e)) swallow(e);
  redraw();
}, { capture: true });

listen("mousedown", (e) => {
  if (!e.isTrusted || ours(e)) return;
  swallow(e);
  if (e.button !== 0) return;
  pointer = { x: e.clientX, y: e.clientY };
  drag = { x: e.clientX + scrollX, y: e.clientY + scrollY, moved: false };
  redraw();
}, { capture: true });

listen("mouseup", (e) => {
  if (!e.isTrusted || ours(e)) return;
  swallow(e);
  if (e.button !== 0 || !drag) return;
  pointer = { x: e.clientX, y: e.clientY };
  const moved = drag.moved;
  const r = dragRect();
  drag = null;
  if (moved && r.width >= DRAG && r.height >= DRAG) return finish(r);
  // A click: what's lit under it.
  snapped = snapAt(e.clientX, e.clientY);
  const s = lit();
  if (s) return finish(s);
  redraw();
}, { capture: true });

for (const type of ["click", "dblclick", "auxclick", "contextmenu", "dragstart", "selectstart"])
  listen(type, (e) => {
    if (e.isTrusted && !ours(e)) swallow(e);
  }, { capture: true });
// Kept from the page, not cancelled: a cancelled pointerdown has Chrome skip the mousedown and mouseup after it.
for (const type of ["pointerdown", "pointerup", "pointermove"])
  listen(type, (e) => {
    if (e.isTrusted && !ours(e)) e.stopImmediatePropagation();
  }, { capture: true });

listen("keydown", (e) => {
  if (!e.isTrusted) return;
  if (e.key === "Escape") {
    swallow(e);
    if (drag) {
      drag = null;
      redraw();
    } else cancel();
  }
}, { capture: true });

listen("scroll", () => {
  if (pointer && !drag) snapped = snapAt(pointer.x, pointer.y);
  redraw();
}, { capture: true, passive: true });
listen("resize", redraw, { passive: true });
listen("pagehide", () => uninstall(), {});

const uninstall = () => {
  for (const [type, fn, options] of listeners) removeEventListener(type, fn, options);
  listeners.length = 0;
  host.remove();
  if (document[KEY] === uninstall) delete document[KEY];
};
Object.defineProperty(document, KEY, { value: uninstall, configurable: true });

document.documentElement.append(host);
if (pointer && !drag) snapped = snapAt(pointer.x, pointer.y);
redraw();
post("result", "true");
`;
