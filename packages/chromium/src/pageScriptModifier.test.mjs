import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../ios/page_script.js", import.meta.url), "utf8");
const modifiers = script.match(/const isMac =[^;]+;\s*const primaryModifier =[^;]+;\s*const secondaryModifier =[^;]+;/)?.[0];
const start = script.indexOf("  // MARK: Capture");
const end = script.indexOf("  // MARK: Link previews", start);
assert.ok(modifiers && start > 0 && end > start);

function fixture(platform) {
  const listeners = new Map();
  const sent = [];
  new Function("navigator", "addEventListener", "send", "isTop", modifiers + script.slice(start, end))(
    { platform },
    (name, callback) => listeners.set(name, callback),
    (...args) => sent.push(args),
    true,
  );
  return {
    sent,
    mouse(fields = {}) {
      let swallowed = 0;
      const event = {
        isTrusted: true,
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        clientX: 10,
        clientY: 20,
        ...fields,
        preventDefault() {
          swallowed++;
        },
        stopImmediatePropagation() {
          swallowed++;
        },
      };
      listeners.get("mousedown")(event);
      return swallowed;
    },
  };
}

test("page Capture uses the desktop primary modifier", () => {
  for (const [platform, primary, other] of [
    ["MacIntel", "metaKey", "ctrlKey"],
    ["Linux x86_64", "ctrlKey", "metaKey"],
    ["Win32", "ctrlKey", "metaKey"],
  ]) {
    const f = fixture(platform);
    assert.equal(f.mouse({ [primary]: true }), 2);
    assert.deepEqual(f.sent, [["captureGesture", { x: 10, y: 20 }]]);
    assert.equal(f.mouse({ [other]: true }), 0);
    assert.equal(f.sent.length, 1);
  }
});

test("page Capture leaves synthetic and unrelated mouse gestures alone", () => {
  const f = fixture("Linux x86_64");
  for (const extra of [{ isTrusted: false }, { button: 1 }, { shiftKey: false }, { altKey: true }, { metaKey: true }]) {
    assert.equal(f.mouse({ ctrlKey: true, ...extra }), 0);
  }
  assert.deepEqual(f.sent, []);
});
