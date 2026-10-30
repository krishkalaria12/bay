import assert from "node:assert/strict";
import test from "node:test";
import { installTextInputSelection } from "./webTextInput.ts";

test("web input supports the shared imperative selection API on the original DOM ref", () => {
  const input = {
    value: "bay browser",
    selectionStart: 0,
    selectionEnd: 0,
    focus() {},
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
  };
  const focus = input.focus;
  installTextInputSelection(input);
  input.setSelection(0, input.value.length);
  assert.equal(input.selectionStart, 0);
  assert.equal(input.selectionEnd, 11);
  input.setSelection(3, 3);
  assert.equal(input.selectionStart, 3);
  assert.equal(input.selectionEnd, 3);
  assert.equal(input.focus, focus);
});

test("selection adapter preserves existing implementations and accepts a cleared ref", () => {
  const selected = [];
  const input = {
    setSelection: (start, end) => selected.push([start, end]),
    setSelectionRange() {
      assert.fail("existing selection implementation must remain in use");
    },
  };
  const select = input.setSelection;
  installTextInputSelection(input);
  installTextInputSelection(input);
  assert.equal(input.setSelection, select);
  input.setSelection(1, 4);
  assert.deepEqual(selected, [[1, 4]]);
  installTextInputSelection(null);
});
