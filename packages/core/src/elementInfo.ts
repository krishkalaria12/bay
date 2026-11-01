// What an element is, for Developer Mode's inspector on desktop (apps/browser developer/inspectorScript.ts) and the
// mobile inspector: its name and a selector for it, size and place, type and colours, the CSS rules that match it,
// React's components for it, which font renders its text, and all of that as text for a coding agent. Page-script
// source run inside a page script, in the page's main world or an isolated one. No backticks inside: it is one string.
/** Page-script source defining nameOf, selectorOf, hex, describe, rulesOf, componentsOf, forAgent and fontOf. */
export const ELEMENT_INFO = String.raw`
const MAX_RULES = 6;
const TICK = "\x60";
const FENCE = TICK + TICK + TICK;
const round = (n) => Math.round(n * 10) / 10;


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

// MARK: Which font renders it

const GENERIC_FAMILIES = ["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong", "-apple-system", "blinkmacsystemfont"];
const unquote = (family) => family.trim().replace(/^["']|["']$/g, "");

// A family is installed when text drawn in it, with each of two different fallbacks, is not the fallback's width.
// document.fonts.check can't tell: it is true for a system font that isn't there, since nothing needs loading.
let measureContext = null;
const fontInstalled = (family, sample) => {
  if (!measureContext) measureContext = document.createElement("canvas").getContext("2d");
  if (!measureContext) return false;
  return ["monospace", "serif"].every((fallback) => {
    measureContext.font = "72px " + fallback;
    const plain = measureContext.measureText(sample).width;
    measureContext.font = "72px \"" + family + "\", " + fallback;
    return measureContext.measureText(sample).width !== plain;
  });
};

// Where a web font comes from: the first url() of the @font-face rules for the family, in style sheets the page lets
// us read.
const fontSourceOf = (family) => {
  const wanted = family.toLowerCase();
  const walk = (rules) => {
    for (const rule of rules) {
      if (rule.type === 5 && unquote(rule.style.getPropertyValue("font-family")).toLowerCase() === wanted) {
        const match = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(rule.style.getPropertyValue("src"));
        if (match) return new URL(match[1], rule.parentStyleSheet && rule.parentStyleSheet.href || location.href).href;
      } else if (rule.cssRules) {
        const found = walk(rule.cssRules);
        if (found) return found;
      }
    }
    return null;
  };
  for (const sheet of document.styleSheets) {
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch (e) {}
    const found = rules && walk(rules);
    if (found) return found;
  }
  return null;
};

const fontOf = (el) => {
  const style = getComputedStyle(el);
  const stack = style.fontFamily.split(",").map(unquote).filter(Boolean);
  const loaded = new Set();
  if (document.fonts) document.fonts.forEach((face) => face.status === "loaded" && loaded.add(unquote(face.family).toLowerCase()));
  const sample = "mmmmmmmmmmlliWW@" + (el.textContent || "").trim().slice(0, 24);
  let rendered = null;
  let web = false;
  for (const family of stack) {
    const lower = family.toLowerCase();
    if (GENERIC_FAMILIES.includes(lower)) {
      rendered = family;
      break;
    }
    if (loaded.has(lower)) {
      rendered = family;
      web = true;
      break;
    }
    if (fontInstalled(family, sample)) {
      rendered = family;
      break;
    }
  }
  return {
    stack,
    rendered: rendered || "serif",
    web,
    source: web ? fontSourceOf(rendered) : null,
    size: style.fontSize,
    weight: style.fontWeight,
    style: style.fontStyle,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    color: hex(style.color),
  };
};
`;
