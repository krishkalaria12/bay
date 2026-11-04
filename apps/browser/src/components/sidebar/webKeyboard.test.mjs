import assert from "node:assert/strict";
import { test } from "node:test";
const { holdsTyping, startWebSidebarKeyboard } = await import("./webKeyboard.ts");

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.style = {};
  }
  setAttribute() {}
  focus() {
    const previous = doc.activeElement;
    doc.activeElement = this;
    if (previous !== this) doc.dispatch("focusin", { target: this });
  }
  blur() {
    if (doc.activeElement === this) doc.activeElement = null;
  }
  remove() {
    this.removed = true;
  }
}
const doc = {
  activeElement: null,
  listeners: {},
  body: { append() {} },
  createElement: (tag) => new Element(tag.toUpperCase()),
  addEventListener(type, listener) {
    this.listeners[type] = listener;
  },
  removeEventListener(type) {
    delete this.listeners[type];
  },
  dispatch(type, event) {
    this.listeners[type]?.(event);
  },
};
const key = (name, mods = {}) => {
  const event = { key: name, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, ...mods };
  event.preventDefault = () => (event.defaultPrevented = true);
  event.stopPropagation = () => {};
  doc.dispatch("keydown", event);
  return event.defaultPrevented;
};

const setup = () => {
  doc.activeElement = null;
  const calls = [];
  const state = { active: false, undo: 0 };
  const keyboard = startWebSidebarKeyboard(
    {
      active: () => state.active,
      runKey: (k) => calls.push(k),
      blur: () => {
        state.active = false;
        calls.push("blur");
      },
      canUndo: () => state.undo > 0,
      undo: () => (state.undo--, calls.push("undo")),
    },
    { document: doc },
  );
  return { calls, state, keyboard };
};

test("focus on the sidebar takes the keys macOS's responder took, and nothing with a modifier", () => {
  const { calls, state, keyboard } = setup();
  assert.equal(key("ArrowDown"), false, "nothing before the sidebar has focus");
  state.active = true;
  keyboard.changed(true);
  for (const name of ["ArrowDown", "ArrowUp", "Enter", " ", "Backspace", "Home", "End", "Escape"]) assert.equal(key(name), true, name);
  assert.equal(key("ArrowDown", { shiftKey: true }), false);
  assert.equal(key("a"), false);
  assert.deepEqual(calls, ["ArrowDown", "ArrowUp", "Enter", "Space", "Backspace", "Home", "End", "Escape"]);
  keyboard.stop();
});

test("a focused row keeps the keys, and focus going anywhere else or a click ends it", () => {
  const { calls, state, keyboard } = setup();
  state.active = true;
  keyboard.changed(true);
  const row = new Element("DIV");
  keyboard.focusRow(row);
  assert.equal(doc.activeElement, row);
  assert.equal(key("ArrowDown"), true);
  new Element("INPUT").focus();
  assert.deepEqual(calls, ["ArrowDown", "blur"]);
  state.active = true;
  doc.dispatch("pointerdown", {});
  assert.deepEqual(calls.at(-1), "blur");
  keyboard.stop();
});

test("Undo comes to the sidebar after an edit, unless someone is typing or on the page", () => {
  const { calls, state, keyboard } = setup();
  state.undo = 1;
  const field = new Element("INPUT");
  field.focus();
  keyboard.armUndo();
  assert.equal(doc.activeElement, field);
  assert.equal(key("z", { ctrlKey: true }), false);
  const page = new Element("EMBED");
  page.focus();
  keyboard.armUndo();
  assert.equal(doc.activeElement, page);
  doc.activeElement = null;
  keyboard.armUndo();
  assert.equal(key("z", { ctrlKey: true, shiftKey: true }), false);
  assert.equal(key("z", { ctrlKey: true }), true);
  assert.equal(key("z", { ctrlKey: true }), false, "nothing left to undo");
  assert.deepEqual(calls, ["undo"]);
  keyboard.stop();
  assert.deepEqual(doc.listeners, {});
});

test("typing is a field, an editor or a page", () => {
  assert.equal(holdsTyping(null), false);
  assert.equal(holdsTyping({ tagName: "DIV" }), false);
  assert.equal(holdsTyping({ tagName: "DIV", isContentEditable: true }), true);
  for (const tagName of ["INPUT", "TEXTAREA", "EMBED"]) assert.equal(holdsTyping({ tagName }), true);
});
