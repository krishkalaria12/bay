import assert from "node:assert/strict";
import test from "node:test";
import { bindSpaceGestures } from "./webSpaceGestures.ts";

function surface() {
  const element = new EventTarget();
  element.style = { touchAction: "auto" };
  element.clientWidth = 300;
  element.getBoundingClientRect = () => ({ width: 300 });
  element.closest = () => null;
  return element;
}
function emit(element, name, fields) {
  const event = Object.assign(new Event(name, { cancelable: true }), fields);
  element.dispatchEvent(event);
  return event;
}
const wheel = (element, fields = {}) => emit(element, "wheel", { deltaX: 24, deltaY: 0, deltaMode: 0, ctrlKey: false, shiftKey: false, ...fields });
const pointer = (element, name, x, y, fields = {}) =>
  emit(element, name, { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, ...fields });

test("horizontal wheel gestures use pager units while vertical scroll, pinch and fields remain untouched", () => {
  const element = surface();
  const seen = [];
  let back = true;
  const remove = bindSpaceGestures(element, () => ({ canSwipeBack: back, canSwipeForward: true, onSwipe: (event) => seen.push(event) }));
  assert.equal(wheel(element).defaultPrevented, true);
  assert.equal(seen[0].phase, "wheel");
  assert.equal(seen[0].distance, 0.5);
  assert.equal(seen[0].direction, "forward");
  assert.equal(wheel(element, { deltaX: 2, deltaY: 20 }).defaultPrevented, false);
  assert.equal(wheel(element, { ctrlKey: true }).defaultPrevented, false);
  back = false;
  assert.equal(wheel(element, { deltaX: -24 }).defaultPrevented, false);
  element.closest = () => ({});
  assert.equal(wheel(element).defaultPrevented, false);
  assert.equal(seen.length, 1);
  remove();
  assert.equal(element.style.touchAction, "auto");
  element.closest = () => null;
  wheel(element);
  assert.equal(seen.length, 1);
});

test("touch swipe selects once and suppresses its click without consuming vertical or mouse drags", () => {
  const element = surface();
  const seen = [];
  let time = 1000;
  const remove = bindSpaceGestures(
    element,
    () => ({ canSwipeBack: true, canSwipeForward: true, onSwipe: (event) => seen.push(event) }),
    () => time,
  );
  pointer(element, "pointerdown", 100, 50);
  assert.equal(pointer(element, "pointermove", 40, 52).defaultPrevented, true);
  assert.equal(pointer(element, "pointerup", 30, 52).defaultPrevented, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].phase, "swipe");
  assert.equal(seen[0].direction, "forward");
  assert.equal(emit(element, "click", {}).defaultPrevented, true);
  time += 400;
  assert.equal(emit(element, "click", {}).defaultPrevented, false);
  pointer(element, "pointerdown", 100, 50);
  assert.equal(pointer(element, "pointermove", 99, 100).defaultPrevented, false);
  pointer(element, "pointerup", 30, 100);
  pointer(element, "pointerdown", 100, 50, { pointerType: "mouse" });
  pointer(element, "pointermove", 30, 50, { pointerType: "mouse" });
  pointer(element, "pointerup", 30, 50, { pointerType: "mouse" });
  assert.equal(seen.length, 1);
  remove();
});
