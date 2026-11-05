// The Developer Mode inspector, run in the page by evaluate (in its main world, with `post` to answer and to message
// the app as "devMode": devMode.ts › onDeveloperMessage). Rulers along the top and left, the element under the pointer
// outlined with its margin and padding, and a click pins it with what it is: size, place, type, colours and the CSS
// rules that match it, to copy for a coding agent or open in DevTools. Its own elements are in a closed shadow root
// the page's CSS and scripts can't reach; while it's on, clicks go to it, not the page. Running it again with `on`
// false takes it away. No template literals or backticks inside: this file's string is one.
export function inspectorScript(on: boolean): string {
  return `const ON = ${on ? "true" : "false"};
${SCRIPT}`;
}

const SCRIPT = String.raw`
const KEY = Symbol.for("bay.developerInspector");
const installed = document[KEY];
if (!ON) {
  if (typeof installed === "function") installed();
  post("result", "true");
  return;
}
if (installed || !document.documentElement) {
  post("result", JSON.stringify(!!installed));
  return;
}
const send = (data) => post("devMode", JSON.stringify(data));
const RULER = 20;
const MAX_RULES = 6;
const TICK = "\x60";
const FENCE = TICK + TICK + TICK;
const round = (n) => Math.round(n * 10) / 10;

const host = document.createElement("bay-inspector");
host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; display: block;";
const shadow = host.attachShadow({ mode: "closed" });
shadow.innerHTML =
  "<style>" +
  ":host { all: initial; }" +
  "* { box-sizing: border-box; }" +
  ".ruler { position: fixed; background: rgba(246,246,247,0.96); }" +
  ".top { left: 0; top: 0; height: " + RULER + "px; width: 100vw; border-bottom: 1px solid rgba(0,0,0,0.12); }" +
  ".left { left: 0; top: 0; width: " + RULER + "px; height: 100vh; border-right: 1px solid rgba(0,0,0,0.12); }" +
  ".corner { position: fixed; left: 0; top: 0; width: " + RULER + "px; height: " + RULER + "px; background: rgb(246,246,247); border-right: 1px solid rgba(0,0,0,0.12); border-bottom: 1px solid rgba(0,0,0,0.12); }" +
  ".box { position: fixed; display: none; }" +
  ".margin { background: rgba(246,178,107,0.35); }" +
  ".border { background: rgba(147,196,125,0.4); }" +
  ".content { background: rgba(111,168,220,0.5); }" +
  ".outline { position: fixed; display: none; outline: 1px solid #2f7cf6; }" +
  ".label { position: fixed; display: none; padding: 2px 6px; border-radius: 4px; background: #2f7cf6; color: #fff; font: 600 11px/14px ui-monospace, Menlo, monospace; white-space: nowrap; }" +
  ".card { position: fixed; display: none; width: 340px; max-height: calc(100vh - 40px); overflow: auto; pointer-events: auto; padding: 14px; border-radius: 16px; background: rgba(28,28,30,0.97); border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 12px 36px rgba(0,0,0,0.35); color: #f2f2f3; font: 13px/18px -apple-system, system-ui, sans-serif; cursor: default; }" +
  ".head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 8px; }" +
  ".name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }" +
  ".size { font: 12px/18px ui-monospace, Menlo, monospace; color: rgba(255,255,255,0.75); white-space: nowrap; }" +
  ".row { display: flex; gap: 12px; padding: 2px 0; }" +
  ".key { width: 64px; flex: none; color: rgba(255,255,255,0.55); }" +
  ".value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }" +
  ".swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.25); }" +
  ".on { color: rgba(255,255,255,0.55); margin: 0 5px; }" +
  ".rules { margin-top: 10px; padding: 8px 10px; border-radius: 9px; background: rgba(255,255,255,0.06); font: 12px/17px ui-monospace, Menlo, monospace; }" +
  ".rule + .rule { margin-top: 8px; }" +
  ".selector { display: flex; justify-content: space-between; gap: 8px; font-weight: 600; }" +
  ".selector span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }" +
  ".source { font-weight: 400; color: rgba(255,255,255,0.45); flex: none; }" +
  ".decl { padding-left: 14px; color: rgba(255,255,255,0.75); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }" +
  ".prop { color: rgba(255,255,255,0.55); }" +
  ".actions { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin-top: 12px; }" +
  "button { all: unset; display: inline-flex; align-items: center; gap: 8px; height: 26px; padding: 0 10px; border-radius: 8px; font: 500 13px/26px -apple-system, system-ui, sans-serif; color: #f2f2f3; background: rgba(255,255,255,0.1); cursor: default; }" +
  "button:hover { background: rgba(255,255,255,0.16); }" +
  "button.primary { background: #f2f2f3; color: #1c1c1e; }" +
  "button.primary:hover { background: #ffffff; }" +
  "kbd { font: 500 11px/16px -apple-system, system-ui, sans-serif; padding: 0 4px; border-radius: 4px; background: rgba(0,0,0,0.1); color: rgba(0,0,0,0.6); }" +
  "</style>" +
  "<div class='box margin'></div><div class='box border'></div><div class='box content'></div><div class='outline'></div>" +
  "<canvas class='ruler top'></canvas><canvas class='ruler left'></canvas><div class='corner'></div>" +
  "<div class='label'></div>" +
  "<div class='card'></div>";
const $ = (selector) => shadow.querySelector(selector);
const marginBox = $(".margin"), borderBox = $(".border"), contentBox = $(".content"), outline = $(".outline");
const label = $(".label"), card = $(".card"), topRuler = $(".top"), leftRuler = $(".left");

let hovered = null;
let pinned = null;
let queued = false;
const target = () => (pinned && pinned.isConnected ? pinned : hovered && hovered.isConnected ? hovered : null);

// MARK: What an element is

const nameOf = (el) => {
  let name = el.tagName.toLowerCase();
  if (el.id) name += "#" + el.id;
  const classes = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean) : [];
  for (const c of classes.slice(0, 2)) name += "." + c;
  return name;
};

const selectorOf = (el) => {
  const parts = [];
  for (let node = el; node && node.nodeType === 1 && parts.length < 6; node = node.parentElement) {
    if (node.id && document.querySelectorAll("#" + CSS.escape(node.id)).length === 1) {
      parts.unshift("#" + CSS.escape(node.id));
      break;
    }
    let part = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent) {
      const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
      if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
    }
    parts.unshift(part);
    if (part === "body" || part === "html") break;
  }
  return parts.join(" > ");
};

const hex = (color) => {
  const m = /rgba?\(([\d.]+),?\s*([\d.]+),?\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\)/.exec(color || "");
  if (!m) return color || "";
  const two = (n) => Math.round(Math.max(0, Math.min(255, +n))).toString(16).padStart(2, "0");
  let alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : +m[4];
  return "#" + two(m[1]) + two(m[2]) + two(m[3]) + (alpha < 1 ? two(alpha * 255) : "");
};
const transparent = (color) => !color || color === "transparent" || /rgba\([^)]*,\s*0\)$/.test(color) || /\/\s*0\)$/.test(color);
const backgroundOf = (el) => {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (!transparent(bg)) return bg;
  }
  return "rgb(255, 255, 255)";
};

const typeOf = (style) => {
  const px = (v) => v.replace(/px$/, "");
  const family = style.fontFamily.split(",")[0].replace(/["']/g, "").trim();
  return px(style.fontSize) + "/" + px(style.lineHeight) + " " + family + " " + style.fontWeight;
};

// As the rule has them, shorthands kept ("margin: 0px", not its four sides): its text, split at the semicolons
// outside parentheses.
const declarationsOf = (style) =>
  style.cssText
    .split(/;(?![^(]*\))/)
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const colon = d.indexOf(":");
      return [d.slice(0, colon).trim(), d.slice(colon + 1).trim()];
    });

const rulesOf = (el) => {
  const found = [];
  let scanned = 0;
  const walk = (rules, source) => {
    for (const rule of rules) {
      if (++scanned > 20000) return;
      if (rule.selectorText !== undefined && rule.style) {
        let matches = false;
        try {
          matches = el.matches(rule.selectorText);
        } catch (e) {}
        if (matches && rule.style.length) found.push({ selector: rule.selectorText, source, decls: declarationsOf(rule.style) });
      } else if (rule.cssRules && (!rule.media || matchMedia(rule.media.mediaText).matches)) {
        walk(rule.cssRules, source);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch (e) {}
    if (!rules) continue;
    const source = sheet.href ? sheet.href.split(/[?#]/)[0].split("/").pop() : "style";
    walk(rules, source);
  }
  const inline = el.getAttribute("style") ? [{ selector: "element.style", source: "", decls: declarationsOf(el.style) }] : [];
  // As DevTools lists them: the element's own first, then the later (winning) rules first.
  return inline.concat(found.reverse()).slice(0, MAX_RULES);
};

// React's component names and, in a development build, where they're written.
const componentsOf = (el) => {
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
  const names = [];
  let source = null;
  for (let fiber = key ? el[key] : null; fiber && names.length < 4; fiber = fiber.return) {
    const type = fiber.type;
    if (!type || typeof type === "string") continue;
    const name = type.displayName || type.name || (type.render && (type.render.displayName || type.render.name));
    if (!name) continue;
    names.push(name);
    if (!source && fiber._debugSource) source = fiber._debugSource.fileName + ":" + fiber._debugSource.lineNumber;
  }
  return { names, source };
};

const describe = (el) => {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return {
    name: nameOf(el),
    width: round(rect.width),
    height: round(rect.height),
    x: round(rect.left + scrollX),
    y: round(rect.top + scrollY),
    type: typeOf(style),
    color: hex(style.color),
    background: hex(backgroundOf(el)),
    rules: rulesOf(el),
  };
};

const forAgent = (el) => {
  const info = describe(el);
  const lines = [];
  lines.push("Element " + TICK + info.name + TICK + " on " + location.href);
  lines.push("- Selector: " + TICK + selectorOf(el) + TICK);
  const react = componentsOf(el);
  if (react.names.length) lines.push("- React: " + react.names.reverse().join(" > ") + (react.source ? " (" + react.source + ")" : ""));
  lines.push("- Size: " + info.width + " × " + info.height + " at " + info.x + ", " + info.y + " (CSS px; viewport " + innerWidth + " × " + innerHeight + ")");
  lines.push("- Type: " + info.type);
  lines.push("- Color: " + info.color + " on " + info.background);
  const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
  if (text) lines.push("- Text: \"" + (text.length > 160 ? text.slice(0, 160) + "…" : text) + "\"");
  if (info.rules.length) {
    lines.push("", "Matched CSS:", FENCE + "css");
    for (const r of info.rules) lines.push(r.selector + " {" + r.decls.map((d) => " " + d[0] + ": " + d[1] + ";").join("") + " }" + (r.source ? " /* " + r.source + " */" : ""));
    lines.push(FENCE);
  }
  let html = el.outerHTML;
  if (html.length > 2000) html = html.slice(0, html.indexOf(">") + 1) + "…";
  lines.push("", "HTML:", FENCE + "html", html, FENCE);
  return lines.join("\n");
};

// MARK: Drawing

const place = (node, left, top, width, height) => {
  node.style.display = width > 0 && height > 0 ? "block" : "none";
  node.style.left = left + "px";
  node.style.top = top + "px";
  node.style.width = Math.max(0, width) + "px";
  node.style.height = Math.max(0, height) + "px";
};

const drawRuler = (canvas, length, horizontal, from, to) => {
  const ratio = devicePixelRatio || 1;
  const w = horizontal ? length : RULER, h = horizontal ? RULER : length;
  if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
  }
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  const g = canvas.getContext("2d");
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.clearRect(0, 0, w, h);
  if (from !== null) {
    g.fillStyle = "rgba(47,124,246,0.22)";
    if (horizontal) g.fillRect(from, 0, to - from, RULER);
    else g.fillRect(0, from, RULER, to - from);
  }
  g.strokeStyle = "rgba(0,0,0,0.35)";
  g.fillStyle = "rgba(0,0,0,0.6)";
  g.font = "9px -apple-system, system-ui, sans-serif";
  g.lineWidth = 1;
  g.beginPath();
  for (let at = 0; at <= length; at += 10) {
    if (at < RULER) continue;
    const tick = at % 100 === 0 ? RULER : at % 50 === 0 ? 8 : 4;
    if (horizontal) {
      g.moveTo(at + 0.5, RULER);
      g.lineTo(at + 0.5, RULER - tick);
    } else {
      g.moveTo(RULER, at + 0.5);
      g.lineTo(RULER - tick, at + 0.5);
    }
    if (at % 100 === 0) {
      if (horizontal) g.fillText(String(at), at + 3, 10);
      else {
        g.save();
        g.translate(10, at + 3);
        g.rotate(Math.PI / 2);
        g.fillText(String(at), 0, 0);
        g.restore();
      }
    }
  }
  g.stroke();
  if (from !== null) {
    g.strokeStyle = "#2f7cf6";
    g.beginPath();
    for (const edge of [from, to]) {
      if (horizontal) {
        g.moveTo(Math.round(edge) + 0.5, 0);
        g.lineTo(Math.round(edge) + 0.5, RULER);
      } else {
        g.moveTo(0, Math.round(edge) + 0.5);
        g.lineTo(RULER, Math.round(edge) + 0.5);
      }
    }
    g.stroke();
  }
};

const text = (tag, className, value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
};

const fillCard = (el) => {
  const info = describe(el);
  card.replaceChildren();
  const head = text("div", "head");
  head.append(text("div", "name", info.name), text("div", "size", info.width + " × " + info.height));
  card.append(head);
  const row = (key, value) => {
    const r = text("div", "row");
    const v = text("div", "value");
    if (typeof value === "string") v.textContent = value;
    else v.append(...value);
    r.append(text("div", "key", key), v);
    card.append(r);
  };
  const swatch = (color) => {
    const s = text("span", "swatch");
    s.style.background = color;
    return s;
  };
  row("Position", info.x + ", " + info.y);
  row("Type", info.type);
  row("Color", [swatch(info.color), document.createTextNode(info.color), text("span", "on", "on"), swatch(info.background), document.createTextNode(info.background)]);
  if (info.rules.length) {
    const box = text("div", "rules");
    for (const r of info.rules) {
      const rule = text("div", "rule");
      const head = text("div", "selector");
      head.append(text("span", "", r.selector), text("span", "source", r.source));
      rule.append(head);
      for (const d of r.decls.slice(0, 8)) {
        const line = text("div", "decl");
        line.append(text("span", "prop", d[0] + ": "), document.createTextNode(d[1] + ";"));
        rule.append(line);
      }
      if (r.decls.length > 8) rule.append(text("div", "decl", "…"));
      box.append(rule);
    }
    card.append(box);
  }
  const actions = text("div", "actions");
  const copy = text("button", "primary", "Copy for Agent");
  copy.append(text("kbd", "", "⌘"), text("kbd", "", "C"));
  copy.addEventListener("click", () => copyFor(el));
  const elements = text("button", "", "Open in Elements");
  elements.addEventListener("click", () => send({ type: "elements" }));
  actions.append(copy, elements);
  card.append(actions);
};

const draw = () => {
  queued = false;
  const el = target();
  drawRuler(topRuler, innerWidth, true, null, null);
  drawRuler(leftRuler, innerHeight, false, null, null);
  if (!el) {
    for (const node of [marginBox, borderBox, contentBox, outline, label]) node.style.display = "none";
    card.style.display = "none";
    return;
  }
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  const n = (v) => parseFloat(v) || 0;
  const m = [n(s.marginTop), n(s.marginRight), n(s.marginBottom), n(s.marginLeft)];
  const b = [n(s.borderTopWidth) + n(s.paddingTop), n(s.borderRightWidth) + n(s.paddingRight), n(s.borderBottomWidth) + n(s.paddingBottom), n(s.borderLeftWidth) + n(s.paddingLeft)];
  place(marginBox, r.left - m[3], r.top - m[0], r.width + m[1] + m[3], r.height + m[0] + m[2]);
  place(borderBox, r.left, r.top, r.width, r.height);
  place(contentBox, r.left + b[3], r.top + b[0], r.width - b[1] - b[3], r.height - b[0] - b[2]);
  place(outline, r.left, r.top, r.width, r.height);
  // Clip the margin and padding bands to their rings: drawn as nested boxes, the inner ones cover the outer.
  marginBox.style.clipPath = "polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, " + m[3] + "px " + m[0] + "px, " + m[3] + "px calc(100% - " + m[2] + "px), calc(100% - " + m[1] + "px) calc(100% - " + m[2] + "px), calc(100% - " + m[1] + "px) " + m[0] + "px, " + m[3] + "px " + m[0] + "px)";
  borderBox.style.clipPath = "polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, " + b[3] + "px " + b[0] + "px, " + b[3] + "px calc(100% - " + b[2] + "px), calc(100% - " + b[1] + "px) calc(100% - " + b[2] + "px), calc(100% - " + b[1] + "px) " + b[0] + "px, " + b[3] + "px " + b[0] + "px)";
  drawRuler(topRuler, innerWidth, true, r.left, r.right);
  drawRuler(leftRuler, innerHeight, false, r.top, r.bottom);
  label.textContent = nameOf(el) + "  " + round(r.width) + " × " + round(r.height);
  label.style.display = "block";
  const labelTop = r.top - 20 >= RULER ? r.top - 20 : Math.min(innerHeight - 20, Math.max(RULER, r.top) + 2);
  label.style.left = Math.max(RULER + 2, Math.min(innerWidth - label.offsetWidth - 4, r.left)) + "px";
  label.style.top = labelTop + "px";
  if (pinned !== el) {
    card.style.display = "none";
    return;
  }
  card.style.display = "block";
  // Beside the element, not over it: below, else above, else to its right, else inside it at its top.
  const w = card.offsetWidth, h = card.offsetHeight;
  const fitsBelow = r.bottom + 10 + h <= innerHeight - 8;
  const fitsAbove = r.top - 30 - h >= RULER + 8;
  const fitsRight = r.right + 10 + w <= innerWidth - 8;
  let left = r.left, top = r.bottom + 10;
  if (!fitsBelow && fitsAbove) top = r.top - 30 - h;
  else if (!fitsBelow && fitsRight) {
    left = r.right + 10;
    top = r.top;
  } else if (!fitsBelow) {
    left = r.left + 12;
    top = Math.max(r.top, RULER) + 12;
  }
  card.style.left = Math.max(RULER + 8, Math.min(innerWidth - w - 8, left)) + "px";
  card.style.top = Math.max(RULER + 8, Math.min(innerHeight - h - 8, top)) + "px";
};
const redraw = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(draw);
};

// MARK: Input

const elementAt = (x, y) => {
  let el = document.elementFromPoint(x, y);
  while (el && el.shadowRoot && el !== host) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el === host ? null : el;
};

const copyFor = (el) => send({ type: "copy", text: forAgent(el) });

const pin = (el) => {
  pinned = el;
  if (el) fillCard(el);
  redraw();
};

const ours = (e) => e.target === host;
const listeners = [];
const listen = (type, fn, options) => {
  addEventListener(type, fn, options);
  listeners.push([type, fn, options]);
};

listen("mousemove", (e) => {
  if (!e.isTrusted || ours(e)) return;
  const el = elementAt(e.clientX, e.clientY);
  if (el && el !== hovered) {
    hovered = el;
    redraw();
  }
}, { capture: true, passive: true });

// The page doesn't get clicks while the inspector is on: a click picks what's under it.
const swallow = (e) => {
  if (!e.isTrusted || ours(e)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
};
for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "auxclick", "contextmenu"]) listen(type, swallow, { capture: true });
listen("click", (e) => {
  if (!e.isTrusted || ours(e)) return;
  swallow(e);
  const el = elementAt(e.clientX, e.clientY);
  pin(el && el === pinned ? null : el);
}, { capture: true });

listen("keydown", (e) => {
  if (!e.isTrusted) return;
  if (e.key === "Escape") {
    swallow(e);
    if (pinned) pin(null);
    else uninstall(true);
  } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "c" && target() && !String(getSelection() || "")) {
    swallow(e);
    copyFor(target());
  }
}, { capture: true });

listen("scroll", redraw, { capture: true, passive: true });
listen("resize", redraw, { passive: true });

const uninstall = (tellApp) => {
  for (const [type, fn, options] of listeners) removeEventListener(type, fn, options);
  host.remove();
  delete document[KEY];
  if (tellApp === true) send({ type: "exit" });
};
Object.defineProperty(document, KEY, { value: () => uninstall(false), configurable: true });

document.documentElement.append(host);
redraw();
post("result", "true");
`;
