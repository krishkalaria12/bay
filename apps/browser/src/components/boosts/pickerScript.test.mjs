import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { cleanSelector } from "../../lib/boosts.ts";
import { pickerScript } from "./pickerScript.ts";

// Explicit CSSOM readbacks include pending substitutions. Any write to the target's declarations fails the test.
function untouchedStyle(cssText = "", declarations = {}) {
  const writes = [];
  const style = new Proxy(
    {
      cssText,
      getPropertyValue: (property) => declarations[property]?.[0] ?? "",
      getPropertyPriority: (property) => declarations[property]?.[1] ?? "",
      setProperty: (...args) => writes.push(["setProperty", ...args]),
      removeProperty: (...args) => writes.push(["removeProperty", ...args]),
    },
    {
      set(_target, property, value) {
        writes.push([property, value]);
        return true;
      },
    },
  );
  const snapshot = () => ({
    cssText: style.cssText,
    declarations: Object.keys(declarations).map((property) => [property, style.getPropertyValue(property), style.getPropertyPriority(property)]),
  });
  return { style, writes, snapshot };
}

// Execute the complete page script with controlled hit testing, selector matches, styles and timers.
function page({ tag = "div", id = "target", classes = [], matches, escapes = {}, inline = untouchedStyle() } = {}) {
  const listeners = new Map(),
    timers = new Map(),
    messages = [];
  let timerId = 0;
  const node = (tagName) => {
    return {
      tagName: tagName.toUpperCase(),
      nodeType: 1,
      id: "",
      classList: Object.assign([], { toggle() {} }),
      children: [],
      isConnected: true,
      offsetWidth: 300,
      offsetHeight: 80,
      style: {},
      animations: [],
      animate(keyframes, options) {
        const animation = {
          keyframes,
          options,
          cancels: 0,
          cancel() {
            this.cancels++;
          },
        };
        this.animations.push(animation);
        return animation;
      },
      getAnimations() {
        throw new Error("picker must retain only its own animations");
      },
      append(...nodes) {
        this.children.push(...nodes);
      },
      remove() {
        this.isConnected = false;
      },
      getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 50, bottom: 60 }),
      addEventListener(type, fn) {
        (this.events ??= new Map()).set(type, fn);
      },
    };
  };
  const body = node("body"),
    target = node(tag),
    controls = new Map();
  Object.assign(target, { style: inline.style, id, classList: Object.assign(classes, { toggle() {} }), parentNode: body });
  body.children.push(target);
  const shadow = {
    querySelector: (selector) => {
      if (!controls.has(selector)) controls.set(selector, node("button"));
      return controls.get(selector);
    },
  };
  const document = {
    body,
    documentElement: node("html"),
    elementFromPoint: () => target,
    querySelectorAll: (selector) => (matches ? matches(selector, target) : [target]),
    createTextNode: (textContent) => ({ textContent }),
    createElement: (tagName) => Object.assign(node(tagName), { attachShadow: () => shadow }),
  };
  const context = vm.createContext({
    document,
    innerWidth: 1000,
    innerHeight: 800,
    Symbol,
    CSS: { escape: (value) => escapes[value] ?? value },
    post: (kind, value) => {
      if (kind === "boost") messages.push(JSON.parse(value));
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
    setTimeout: (fn) => {
      const id = ++timerId;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  const run = (mode, pickerId = "one") => vm.runInContext(`(function () { ${pickerScript(mode, pickerId)} })()`, context);
  const event = (type, extra = {}) => {
    for (const fn of Array.from(listeners.get(type) ?? []))
      fn({ isTrusted: true, target, clientX: 20, clientY: 20, preventDefault() {}, stopImmediatePropagation() {}, ...extra });
  };
  const click = (selector) => controls.get(selector).events.get("click")();
  const flush = () => {
    for (const [id, fn] of Array.from(timers)) {
      timers.delete(id);
      fn();
    }
  };
  return { run, event, click, flush, messages, target, document, timers };
}

for (const stop of ["done", "escape", "uninstall", "replacement"]) {
  test(`zap commits before ${stop}, with no selection timer left behind`, () => {
    const p = page();
    p.run("zap");
    p.event("click");
    p.click(".this");
    assert.equal(p.messages.length, 1);
    assert.equal(p.messages[0].type, "select");
    assert.equal(p.messages[0].pickerId, "one");
    if (stop === "done") p.click(".done");
    else if (stop === "escape") p.event("keydown", { key: "Escape" });
    else p.run(stop === "replacement" ? "zap" : null, "two");
    p.flush();
    assert.equal(p.messages.filter((m) => m.type === "select").length, 1);
    assert.equal(p.timers.size, 0);
  });
}

test("shadow content picks the document host, leaving unrelated document nodes alone", () => {
  const unrelated = {};
  const p = page({ tag: "site-card", matches: (selector, target) => (selector.includes("site-card") ? [target] : [unrelated]) });
  let descended = false;
  p.target.shadowRoot = {
    elementFromPoint: () => {
      descended = true;
      return { tagName: "DIV", nodeType: 1, classList: [], id: "inner" };
    },
  };
  p.run("focus");
  p.event("click");
  assert.equal(descended, false);
  assert.match(p.messages[0].selector, /site-card/);
});

test("a selector that misses the chosen node cannot be committed", () => {
  const p = page({ matches: () => [{}] });
  p.run("focus");
  p.event("click");
  assert.equal(p.messages.length, 0);
});

for (const [id, classes, escapes, expected] of [
  ["promo:banner", [], { "promo:banner": "promo\\:banner" }, "#promo\\:banner"],
  ["123", [], { 123: "\\31 23" }, "#\\31 23"],
  ["", ["ad[slot]"], { "ad[slot]": "ad\\[slot\\]" }, ".ad\\[slot\\]"],
]) {
  test(`picker keeps escaped selector for ${id || classes[0]}`, () => {
    const p = page({ id, classes, escapes });
    p.run("pick");
    p.event("click");
    p.click(".this");
    const selector = p.messages[0].selector;
    assert.ok(selector.includes(expected), selector);
    assert.equal(cleanSelector(selector), selector);
  });
}

const styleCases = [
  ["absent inline styles", "", {}],
  [
    "opacity and transition shorthand",
    "opacity: 0.65 !important; transition: transform 2s linear;",
    {
      opacity: ["0.65", "important"],
      transition: ["transform 2s linear", ""],
      "transition-property": ["transform", ""],
      "transition-duration": ["2s", ""],
      "transition-timing-function": ["linear", ""],
      "transition-delay": ["0s", ""],
      "transition-behavior": ["normal", ""],
    },
  ],
  [
    "duration-only longhand",
    "transition-duration: 2s !important; opacity: 0.4;",
    {
      "transition-duration": ["2s", "important"],
      opacity: ["0.4", ""],
    },
  ],
  [
    "pending-substitution shorthand",
    "transition: var(--motion) !important; opacity: var(--alpha);",
    {
      transition: ["var(--motion)", "important"],
      opacity: ["var(--alpha)", ""],
      "transition-property": ["", "important"],
      "transition-duration": ["", "important"],
      "transition-timing-function": ["", "important"],
      "transition-delay": ["", "important"],
      "transition-behavior": ["", "important"],
    },
  ],
  [
    "mixed overrides and priorities",
    "transition: var(--motion); transition-duration: 2s !important; transition-delay: 1s; opacity: 0.4 !important;",
    {
      transition: ["", ""],
      "transition-property": ["", ""],
      "transition-duration": ["2s", "important"],
      "transition-timing-function": ["", ""],
      "transition-delay": ["1s", ""],
      "transition-behavior": ["", ""],
      opacity: ["0.4", "important"],
    },
  ],
];
for (const cleanup of ["timer", "done", "escape", "uninstall", "pagehide", "replacement"]) {
  for (const [name, cssText, declarations] of styleCases) {
    test(`owned fade leaves ${name} untouched through repeated zaps and ${cleanup}`, () => {
      const inline = untouchedStyle(cssText, declarations);
      const before = inline.snapshot();
      const p = page({ inline });
      // A page-owned animation must remain alone, even when it exists before the picker.
      const pageAnimation = p.target.animate([{ transform: "scale(2)" }], { duration: 1000 });
      p.run("zap");
      for (let i = 0; i < 2; i++) {
        p.event("click");
        p.click(".this");
        assert.deepEqual(inline.snapshot(), before);
        assert.deepEqual(inline.writes, [], "no temporary or cleanup writes to page styles");
      }
      const [firstFade, latestFade] = p.target.animations.slice(1);
      assert.equal(firstFade.cancels, 1, "repeated zap cancels the previous owned animation");
      assert.equal(latestFade.cancels, 0);
      assert.deepEqual(
        JSON.parse(JSON.stringify(latestFade.keyframes)),
        [{ opacity: 0 }],
        "one target keyframe preserves the computed underlying starting opacity",
      );
      assert.equal(latestFade.options.duration, 140);
      assert.equal(latestFade.options.fill, "forwards");
      if (cleanup === "timer") p.flush();
      else if (cleanup === "pagehide") p.event("pagehide");
      else if (cleanup === "done") p.click(".done");
      else if (cleanup === "escape") p.event("keydown", { key: "Escape" });
      else p.run(cleanup === "replacement" ? "zap" : null, "two");
      p.run(null);
      p.flush();
      assert.equal(firstFade.cancels, 1);
      assert.equal(latestFade.cancels, 1);
      assert.equal(pageAnimation.cancels, 0);
      assert.deepEqual(inline.snapshot(), before);
      assert.deepEqual(inline.writes, []);
      assert.equal(p.timers.size, 0);
      assert.equal(p.messages.filter((message) => message.type === "select").length, 2);
    });
  }
}
