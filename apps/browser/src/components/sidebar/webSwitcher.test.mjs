import assert from "node:assert/strict";
import { test } from "node:test";
const { startWebSwitcherCapture } = await import("./webSwitcher.ts");

const listeners = {};
const windowListeners = {};
const doc = {
  activeElement: null,
  body: { append() {} },
  createElement: () => ({
    style: {},
    setAttribute() {},
    focus() {
      doc.activeElement = this;
    },
    blur() {
      if (doc.activeElement === this) doc.activeElement = null;
    },
    remove() {},
  }),
  addEventListener: (type, listener) => (listeners[type] = listener),
  removeEventListener: (type) => delete listeners[type],
};
const win = {
  addEventListener: (type, listener) => (windowListeners[type] = listener),
  removeEventListener: (type) => delete windowListeners[type],
};
const fire = (type, key, mods = {}) => {
  const event = { key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, ...mods };
  event.preventDefault = () => (event.defaultPrevented = true);
  event.stopPropagation = () => {};
  listeners[type]?.(event);
  return event.defaultPrevented;
};
const start = (focused = null) => {
  doc.activeElement = focused;
  const calls = [];
  const capture = startWebSwitcherCapture(
    { move: (step) => calls.push(step), cancel: () => calls.push("cancel"), commit: () => calls.push("commit") },
    { document: doc, window: win },
  );
  return { calls, capture };
};

test("arrows move and Escape cancels while Ctrl is down; other keys are swallowed and Ctrl+Tab passes", () => {
  const { calls, capture } = start();
  assert.equal(fire("keydown", "ArrowRight", { ctrlKey: true }), true);
  assert.equal(fire("keydown", "ArrowLeft", { ctrlKey: true }), true);
  assert.equal(fire("keydown", "Tab", { ctrlKey: true }), false);
  assert.equal(fire("keydown", "a", { ctrlKey: true }), true);
  assert.equal(fire("keydown", "Escape", { ctrlKey: true }), true);
  assert.deepEqual(calls, [1, -1, "cancel"]);
  capture.stop();
});

test("letting Ctrl go commits, even when the release came before focus did, and leaving the app commits", () => {
  const { calls, capture } = start();
  fire("keyup", "Shift", { ctrlKey: true });
  fire("keyup", "Control");
  fire("keydown", "ArrowRight");
  windowListeners.blur();
  assert.deepEqual(calls, ["commit", "commit", "commit"]);
  capture.stop();
});

test("a click cancels, and the capture takes focus from a page and gives it up", () => {
  const page = { tagName: "EMBED" };
  const { calls, capture } = start(page);
  assert.equal(capture.fromPage, true);
  assert.notEqual(doc.activeElement, page);
  listeners.pointerup();
  assert.deepEqual(calls, ["cancel"]);
  capture.stop();
  assert.equal(doc.activeElement, null);
  assert.deepEqual(listeners, {});
  assert.deepEqual(windowListeners, {});
  assert.equal(start().capture.fromPage, false);
});
