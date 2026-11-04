import test from "node:test";
import assert from "node:assert/strict";
import { setWebFocusRing } from "./webFocusRing.ts";
import { removeWebTooltip, setWebTooltip } from "./webTooltip.ts";

// As much of the DOM as a tooltip and a ring touch; the real thing was checked in Chromium.
class Node {
  attributes = new Map();
  listeners = {};
  children = [];
  style = {};
  textContent = "";
  isConnected = true;
  constructor(document, control = false) {
    this.ownerDocument = document;
    this.control = control;
  }
  getAttribute = (name) => this.attributes.get(name) ?? null;
  setAttribute = (name, value) => void this.attributes.set(name, value);
  removeAttribute = (name) => void this.attributes.delete(name);
  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }
  removeEventListener(type) {
    delete this.listeners[type];
  }
  fire = (type, event = {}) => this.listeners[type]?.(event);
  matches = () => this.control;
  querySelectorAll = () => this.children.filter((child) => child.control);
  contains = (other) => other === this || this.children.includes(other);
  getBoundingClientRect = () => ({ left: 100, top: 40, right: 130, bottom: 70, width: 30, height: 30 });
  appendChild = (child) => void (this.mounted = child);
  remove() {
    this.ownerDocument.body.mounted = null;
  }
}
const documentWith = () => {
  const styles = new Map();
  const document = {
    head: { appendChild: (style) => styles.set(style.id, style) },
    documentElement: {
      clientWidth: 800,
      clientHeight: 600,
      attributes: new Map(),
      setAttribute(name, value) {
        this.attributes.set(name, value);
      },
      removeAttribute(name) {
        this.attributes.delete(name);
      },
    },
    getElementById: (id) => styles.get(id) ?? null,
    createElement: () => new Node(document),
    handlers: {},
    addEventListener(type, handler) {
      this.handlers[type] = handler;
    },
    removeEventListener() {},
    styles,
  };
  document.body = new Node(document);
  return document;
};

test("a ring needs one stylesheet, and a view only says when it draws its own", () => {
  const document = documentWith();
  const node = new Node(document);
  setWebFocusRing(node);
  setWebFocusRing(node, undefined);
  assert.equal(document.styles.size, 1);
  assert.equal(node.attributes.size, 0);
  setWebFocusRing(node, false);
  assert.equal(node.getAttribute("data-bay-no-focus-ring"), "");
  setWebFocusRing(node, true);
  assert.equal(node.attributes.size, 0);
});

test("the sheet leaves pages, focus moved by code and text fields alone", () => {
  const document = documentWith();
  setWebFocusRing(new Node(document));
  const css = [...document.styles.values()][0].textContent;
  assert.match(css, /html\[data-bay-tabbing\] :focus-visible:not\(embed\):not\(input\):not\(textarea\):not\(select\):not\(\[tabindex="-1"\]\)/);
  assert.match(css, /input:focus,\s*textarea:focus,\s*select:focus[\s\S]*outline: none !important/);
});

test("a ring shows from a Tab until the next press of the pointer, and no other key starts it", () => {
  const document = documentWith();
  setWebFocusRing(new Node(document));
  const tabbing = () => document.documentElement.attributes.has("data-bay-tabbing");
  document.handlers.keydown({ key: "t", ctrlKey: true });
  assert.equal(tabbing(), false);
  document.handlers.keydown({ key: "Tab", ctrlKey: true });
  assert.equal(tabbing(), false, "Ctrl+Tab is the switcher");
  document.handlers.keydown({ key: "Tab" });
  assert.equal(tabbing(), true);
  document.handlers.pointerdown();
  assert.equal(tabbing(), false);
});

test("a tooltip shows after a pause, or at once for the keyboard, and goes with its view", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const document = documentWith();
  const node = new Node(document);
  setWebTooltip(node, "Reload (Ctrl+R)");
  node.fire("mouseenter");
  t.mock.timers.tick(499);
  assert.equal(document.body.mounted, undefined);
  t.mock.timers.tick(1);
  assert.equal(document.body.mounted.textContent, "Reload (Ctrl+R)");
  assert.equal(document.body.mounted.getAttribute("role"), "tooltip");
  removeWebTooltip(node);
  assert.equal(document.body.mounted, null);
  assert.deepEqual(Object.keys(node.listeners), []);
  const focused = new Node(document);
  focused.closest = () => focused;
  setWebTooltip(focused, "Back");
  focused.fire("focusin", { target: focused });
  assert.equal(document.body.mounted.textContent, "Back");
});

test("a tooltip names an icon button with no other name, and only that", () => {
  const document = documentWith();
  const wrapper = new Node(document);
  const button = new Node(document, true);
  wrapper.children = [button];
  setWebTooltip(wrapper, "Close");
  assert.equal(button.getAttribute("aria-label"), "Close");
  setWebTooltip(wrapper, "Close Tab");
  assert.equal(button.getAttribute("aria-label"), "Close Tab");
  removeWebTooltip(wrapper);
  assert.equal(button.getAttribute("aria-label"), null);
  const named = new Node(document, true);
  named.setAttribute("aria-label", "Reload");
  setWebTooltip(named, "Reload (Ctrl+R)");
  assert.equal(named.getAttribute("aria-label"), "Reload");
  const texted = new Node(document, true);
  texted.textContent = "Share";
  setWebTooltip(texted, "Share this page");
  assert.equal(texted.getAttribute("aria-label"), null);
});
