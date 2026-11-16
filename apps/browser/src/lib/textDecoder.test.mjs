import test from "node:test";
import assert from "node:assert/strict";

// Node has its own TextDecoder: take it away while the polyfill loads, then compare the two.
const real = globalThis.TextDecoder;

delete globalThis.TextDecoder;

await import("./textDecoder.ts");

const Polyfill = globalThis.TextDecoder;

globalThis.TextDecoder = real;

test("it decodes UTF-8 as the platform's does, invalid bytes included", () => {
  assert.notEqual(Polyfill, real);

  for (const text of ["", "hello", "héllo wörld", "日本語テキスト", "emoji 🌊🎉", "\u0000\u007f\u0080߿ࠀ￿", `${"a".repeat(20000)}🌊`])
    assert.equal(new Polyfill("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(text)), text);

  for (const bytes of [[0xff], [0xc3], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xc0, 0x80], [0x41, 0x80, 0x42], [0xf4, 0x90, 0x80, 0x80]])
    assert.equal(new Polyfill().decode(new Uint8Array(bytes)), new real().decode(new Uint8Array(bytes)), JSON.stringify(bytes));
});

test("a byte order mark is dropped unless asked to keep it, and fatal throws", () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]);
  assert.equal(new Polyfill().decode(bom), "A");
  assert.equal(new Polyfill("utf-8", { ignoreBOM: true }).decode(bom), "﻿A");
  assert.throws(() => new Polyfill("utf-8", { fatal: true }).decode(new Uint8Array([0xff])), TypeError);
  assert.throws(() => new Polyfill("utf-16le"), RangeError);
});
