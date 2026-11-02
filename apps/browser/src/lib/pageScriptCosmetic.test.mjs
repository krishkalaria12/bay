import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../../../../packages/chromium/ios/page_script.js", import.meta.url), "utf8");
const start = script.indexOf("  let cosmeticOn = false;");
const end = script.indexOf("  handlers.config =", start);
assert.ok(start > 0 && end > start);
const source = script.slice(start, end);

class Style {
  values = new Map();
  get length() {
    return this.values.size;
  }
  getPropertyValue(name) {
    return this.values.get(name)?.[0] ?? "";
  }
  getPropertyPriority(name) {
    return this.values.get(name)?.[1] ?? "";
  }
  setProperty(name, value, priority = "") {
    this.values.set(name, [value, priority]);
    [...this.values.keys()].forEach((key, index) => {
      this[index] = key;
    });
  }
  removeProperty(name) {
    this.values.delete(name);
  }
  set cssText(text) {
    this.values.clear();
    for (const declaration of text.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 1) continue;
      const value = declaration.slice(colon + 1).trim();
      this.setProperty(declaration.slice(0, colon).trim(), value.replace(/\s*!important$/, ""), value.endsWith("!important") ? "important" : "");
    }
  }
}
class Element {
  nodeType = 1;
  children = [];
  parentElement = null;
  style = new Style();
  attributes = new Map();
  constructor({ classes = [], id = "", text = "", tag = "div", attributes = {}, children = [] } = {}) {
    this.classList = [...classes];
    this.classList.remove = (name) => {
      const index = this.classList.indexOf(name);
      if (index >= 0) this.classList.splice(index, 1);
    };
    this.textContent = text;
    this.tagName = tag;
    if (id) this.attributes.set("id", id);
    for (const [key, value] of Object.entries(attributes)) this.attributes.set(key, value);
    for (const child of children) this.append(child);
  }
  append(child) {
    child.parentElement = this;
    this.children.push(child);
  }
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  getAttributeNames() {
    return [...this.attributes.keys()];
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  remove() {
    if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  matches(selector) {
    if (selector === "[id],[class]") return this.attributes.has("id") || this.classList.length > 0;
    if (selector.startsWith(".")) return this.classList.includes(selector.slice(1));
    if (selector.startsWith("#")) return this.getAttribute("id") === selector.slice(1);
    return selector === "*" || this.tagName === selector;
  }
  querySelectorAll(selector) {
    const out = [];
    const direct = selector.startsWith(":scope > ");
    const match = direct ? selector.slice(9) : selector;
    const visit = (el) => {
      for (const child of el.children) {
        if (child.matches(match)) out.push(child);
        if (!direct) visit(child);
      }
    };
    visit(this);
    return out;
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
}

function page(elements = []) {
  const root = new Element({ tag: "html", children: elements });
  const timers = [];
  const observers = [];
  const messages = [];
  const location = { href: "https://example.com/news?q=1", pathname: "/news", search: "?q=1" };
  const document = {
    nodeType: 9,
    documentElement: root,
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    createElement: (tag) => new Element({ tag }),
    createExpression: (xpath) => ({
      evaluate: (node) => {
        const matches = node.querySelectorAll(xpath.replace(".//", ""));
        return { snapshotLength: matches.length, snapshotItem: (index) => matches[index] };
      },
    }),
  };
  class MutationObserver {
    connected = false;
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe() {
      this.connected = true;
    }
    disconnect() {
      this.connected = false;
    }
  }
  const run = new Function(
    "document",
    "MutationObserver",
    "send",
    "setTimeout",
    "guard",
    "location",
    "isArray",
    "fromJSON",
    "getComputedStyle",
    "window",
    `${source}; return { installCosmetic, installProcedural };`,
  );
  const api = run(
    document,
    MutationObserver,
    (kind, data) => messages.push({ kind, ...data }),
    (fn) => timers.push(fn),
    (fn) => fn,
    location,
    Array.isArray,
    JSON.parse,
    (node, pseudo) => node.computed?.[pseudo ?? "normal"] ?? node.style,
    {},
  );
  const drain = () => {
    let runs = 0;
    while (timers.length) {
      assert.ok(runs++ < 20, "cosmetic work does not schedule itself forever");
      timers.shift()();
    }
  };
  return {
    ...api,
    root,
    messages,
    drain,
    location,
    mutate(records) {
      for (const observer of observers) if (observer.connected) observer.callback(records);
      drain();
    },
  };
}
const css = (arg) => ({ type: "css-selector", arg });
const op = (type, arg) => ({ type, arg });
const rule = (selector, action) => JSON.stringify({ selector, ...(action && { action }) });

test("generic cosmetics send every class and id in batches within the native limit", () => {
  for (const count of [4000, 4001, 9001]) {
    const elements = Array.from({ length: count }, (_, i) => new Element({ classes: [`class-${i}`], id: `id-${i}` }));
    const p = page(elements);
    p.installCosmetic();
    p.drain();
    assert.equal(p.messages.length, Math.ceil(count / 4000));
    for (const message of p.messages) {
      assert.ok(message.classes.length <= 4000);
      assert.ok(message.ids.length <= 4000);
    }
    // Model the native boundary: no names may disappear even after it truncates a message.
    assert.equal(new Set(p.messages.flatMap((m) => m.classes.slice(0, 4000))).size, count);
    assert.equal(new Set(p.messages.flatMap((m) => m.ids.slice(0, 4000))).size, count);
    p.mutate([{ type: "attributes", target: elements[0] }]);
    assert.equal(p.messages.length, Math.ceil(count / 4000), "seen names are not sent again");
  }
});

test("procedural text matches hide elements and restore their styles when text changes", () => {
  const ad = new Element({ classes: ["tile"], text: "Sponsored [deal]" });
  const article = new Element({ classes: ["tile"], text: "Reader's article" });
  ad.style.setProperty("display", "block");
  const p = page([ad, article]);
  p.installProcedural([rule([css(".tile"), op("has-text", "[deal]")])]);
  assert.equal(ad.style.getPropertyValue("display"), "none");
  assert.equal(ad.style.getPropertyPriority("display"), "important");
  assert.equal(article.style.getPropertyValue("display"), "");
  ad.textContent = "Updated article";
  p.mutate([{ type: "characterData", target: ad }]);
  assert.equal(ad.style.getPropertyValue("display"), "block");
  article.textContent = "A [deal] now";
  p.mutate([{ type: "characterData", target: article }]);
  assert.equal(article.style.getPropertyValue("display"), "none");
});

test("procedural actions remove elements, attributes and classes and apply declared styles", () => {
  const remove = new Element({ classes: ["remove"] });
  const attr = new Element({ classes: ["attr"], attributes: { onclick: "track()" } });
  const classes = new Element({ classes: ["classes", "advert"] });
  const styled = new Element({ classes: ["styled"] });
  const p = page([remove, attr, classes, styled]);
  p.installProcedural([
    rule([css(".remove")], { type: "remove" }),
    rule([css(".attr")], { type: "remove-attr", arg: "onclick" }),
    rule([css(".classes")], { type: "remove-class", arg: "advert" }),
    rule([css(".styled")], { type: "style", arg: "color: red!important; margin: 0" }),
  ]);
  assert.equal(remove.parentElement, null);
  assert.equal(attr.getAttribute("onclick"), null);
  assert.equal(classes.classList.includes("advert"), false);
  assert.equal(styled.style.getPropertyValue("color"), "red");
  assert.equal(styled.style.getPropertyPriority("color"), "important");
  assert.equal(styled.style.getPropertyValue("margin"), "0");
  p.mutate([{ type: "attributes", target: styled }]);
  assert.equal(styled.style.getPropertyValue("color"), "red");
});

test("procedural operators chain ancestors and descendants, and match attributes, CSS, paths and text lengths", () => {
  const label = new Element({ classes: ["label"], text: "SPONSORED" });
  const ad = new Element({ classes: ["tile"], children: [label], attributes: { "data-ad": "slot-12" } });
  ad.style.setProperty("position", "fixed");
  const p = page([ad]);
  p.installProcedural([
    rule([
      css(".label"),
      op("has-text", "/sponsored/i"),
      op("upward", "1"),
      op("matches-attr", '"data-ad"="/slot-\\d+/"'),
      op("matches-css", "position: fixed"),
      op("matches-path", "/news"),
      css(" .label"),
      op("min-text-length", "5"),
    ]),
  ]);
  assert.equal(label.style.getPropertyValue("display"), "none");
  assert.equal(ad.style.getPropertyValue("display"), "");
});

test("XPath and malformed rules do not prevent later valid rules or new DOM nodes", () => {
  const ad = new Element({ classes: ["tile"], children: [new Element({ tag: "span", text: "Ad" })] });
  const p = page([ad]);
  p.installProcedural(["{", rule([op("unknown", "x")]), rule([css(".tile"), op("xpath", ".//span"), op("has-text", "/^Ad$/")])]);
  assert.equal(ad.children[0].style.getPropertyValue("display"), "none");
  const added = new Element({ tag: "span", text: "Ad" });
  ad.append(added);
  p.mutate([{ type: "childList", addedNodes: [added], target: ad }]);
  assert.equal(added.style.getPropertyValue("display"), "none");
});

test("quoted attributes and CSS pseudo-element content keep their distinct quoting rules", () => {
  const ad = new Element({ classes: ["tile"], attributes: { "data-ad": "slot-12" } });
  const before = new Style();
  before.setProperty("content", '"Sponsored"');
  ad.computed = { "::before": before };
  const p = page([ad]);
  p.installProcedural([rule([css(".tile"), op("matches-attr", '"data-ad=slot-12"'), op("matches-css", 'before, content: "Sponsored"')])]);
  assert.equal(ad.style.getPropertyValue("display"), "none");
});
