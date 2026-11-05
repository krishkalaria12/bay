import assert from "node:assert/strict";
import { test } from "node:test";

// The web field, as far as writeInline.web.ts reads it.
class Field {
  value = "";
  selectionStart = 0;
  selectionEnd = 0;
  listeners = {};
  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}
globalThis.HTMLInputElement = Field;
globalThis.HTMLTextAreaElement = class {};
globalThis.document = { activeElement: null };
const { selectInline, writeInline } = await import("./writeInline.web.ts");

const focusedField = (value, caret = value.length) => {
  const field = new Field();
  field.value = value;
  field.setSelectionRange(caret, value.length);
  document.activeElement = field;
  return field;
};

test("a completion is accepted with the caret just past what was typed, then selected once shown", async () => {
  const field = focusedField("goo");
  assert.equal(await writeInline(field, "goo", "gle.com"), 1);
  field.value = "google.com";
  selectInline(field, "goo", "gle.com");
  assert.deepEqual([field.selectionStart, field.selectionEnd], [3, 10]);
});

test("a caret elsewhere, an unfocused field or an IME's marked text takes no completion", async () => {
  assert.equal(await writeInline(focusedField("goo", 1), "goo", "gle.com"), 0);
  const unfocused = focusedField("goo");
  document.activeElement = null;
  assert.equal(await writeInline(unfocused, "goo", "gle.com"), 0);
  const composing = focusedField("goo");
  await writeInline(composing, "goo", "gle.com");
  composing.listeners.compositionstart();
  assert.equal(await writeInline(composing, "goo", "gle.com"), 0);
  composing.listeners.compositionend();
  assert.equal(await writeInline(composing, "goo", "gle.com"), 1);
});

test("clearing a deleted completion is accepted while the field still shows it", async () => {
  assert.equal(await writeInline(focusedField("google.com"), "goo", ""), 1);
});

test("nothing is selected before the field shows the completion", () => {
  const field = focusedField("goo");
  selectInline(field, "goo", "gle.com");
  assert.deepEqual([field.selectionStart, field.selectionEnd], [3, 3]);
});

test("a view that isn't a text field can't take a completion", () => {
  assert.equal(writeInline({}, "goo", "gle.com"), null);
});
