import assert from "node:assert/strict";
import { test } from "node:test";
const { fileDragPath, watchFileDrag } = await import("../../../../../packages/desktop/src/webFileDrag.ts");

class Target {
  listeners = {};
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  removeEventListener(type, listener) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((other) => other !== listener);
  }
  fire(type, event = {}) {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}
const setup = (source = { path: "/Downloads/report.pdf", relative: null }) => {
  const document = new Target();
  const element = new Target();
  element.ownerDocument = document;
  element.events = [];
  element.dispatchEvent = (event) => element.events.push(event.type);
  const drags = [];
  const stop = watchFileDrag(
    element,
    () => source,
    (file) => drags.push(file),
  );
  return { document, element, drags, stop };
};
const press = (mods = {}) => ({ button: 0, ctrlKey: false, clientX: 10, clientY: 10, ...mods });

test("a press that moves past the threshold starts one drag and ends the view's press", () => {
  const { document, element, drags } = setup();
  element.fire("pointerdown", press());
  document.fire("pointermove", { clientX: 12, clientY: 12 });
  assert.equal(drags.length, 0, "a shaky click is a click");
  document.fire("pointermove", { clientX: 30, clientY: 10 });
  document.fire("pointermove", { clientX: 40, clientY: 10 });
  assert.deepEqual(drags, [{ path: "/Downloads/report.pdf", relative: null }]);
  assert.deepEqual(element.events, ["dragstart"]);
});

test("a click, another button, a context click or nothing to drag start no drag", () => {
  const { document, element, drags } = setup();
  element.fire("pointerdown", press());
  document.fire("pointerup");
  document.fire("pointermove", { clientX: 90, clientY: 90 });
  for (const mods of [{ button: 1 }, { button: 2 }, { ctrlKey: true }]) {
    element.fire("pointerdown", press(mods));
    document.fire("pointermove", { clientX: 90, clientY: 90 });
  }
  assert.equal(drags.length, 0);
  const none = setup(null);
  none.element.fire("pointerdown", press());
  none.document.fire("pointermove", { clientX: 90, clientY: 90 });
  assert.equal(none.drags.length, 0);
});

test("a drag that ends back on its row isn't a click, and the next press is", () => {
  const { document, element } = setup();
  const swallowed = () => {
    const event = { stopped: false, preventDefault() {}, stopPropagation: () => (event.stopped = true) };
    element.fire("click", event);
    return event.stopped;
  };
  element.fire("pointerdown", press());
  document.fire("pointermove", { clientX: 40, clientY: 10 });
  assert.equal(swallowed(), true);
  element.fire("pointerdown", press());
  document.fire("pointerup");
  assert.equal(swallowed(), false);
});

test("stopping leaves nothing listening", () => {
  const { document, element, stop } = setup();
  element.fire("pointerdown", press());
  document.fire("pointerup");
  stop();
  assert.deepEqual(document.listeners, { pointermove: [], pointerup: [], pointercancel: [] });
  assert.deepEqual(element.listeners.pointerdown, []);
  assert.deepEqual(element.listeners.click ?? [], []);
});

test("a capture's file URL drags as its path on each desktop", () => {
  assert.equal(fileDragPath("/Downloads/a.pdf"), "/Downloads/a.pdf");
  assert.equal(fileDragPath("file:///tmp/My%20Capture.png"), "/tmp/My Capture.png");
  assert.equal(fileDragPath("file:///C:/Users/me/a%20b.png"), "C:\\Users\\me\\a b.png");
});
