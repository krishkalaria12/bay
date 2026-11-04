import test from "node:test";
import assert from "node:assert/strict";
import { keyCode, setKeyClaims, webKeyClaimed, webKeyMatches } from "./webKeyboard.ts";
const event = (overrides) => ({ key: "Enter", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...overrides });
test("web controls consume their arrow, escape and shifted bindings exactly", () => {
  assert.equal(webKeyMatches({ key: "Left", altKey: true }, event({ key: "ArrowLeft", altKey: true })), true);
  assert.equal(webKeyMatches({ key: "Escape" }, event({ key: "Escape" })), true);
  assert.equal(webKeyMatches({ key: "Enter", shiftKey: true }, event()), false);
  assert.equal(webKeyMatches({ key: "Enter" }, event({ ctrlKey: true })), false);
  assert.equal(webKeyMatches({ key: "Space" }, event({ key: " " })), true);
});
test("web physical codes preserve function keys and normalize letters", () => {
  assert.equal(keyCode("t"), "KeyT");
  assert.equal(keyCode("4"), "Digit4");
  assert.equal(keyCode("Left"), "ArrowLeft");
  assert.equal(keyCode("F6"), "F6");
});
test("a key counts as taken by the view it's in or any view around it, and only that key", () => {
  const dialog = { parentElement: null };
  const field = { parentElement: dialog };
  setKeyClaims(dialog, () => [{ key: "Escape" }]);
  setKeyClaims(field, () => undefined);
  assert.equal(webKeyClaimed(event({ key: "Escape", target: field })), true);
  assert.equal(webKeyClaimed(event({ key: "t", ctrlKey: true, target: field })), false);
  assert.equal(webKeyClaimed(event({ key: "Escape", target: { parentElement: null } })), false);
});
