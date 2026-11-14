import assert from "node:assert/strict";
import { after, test } from "node:test";
import { quoteLines, renderQuoteCard } from "../../../../../packages/desktop/src/quoteCardCanvas.ts";
import { quoteCards } from "../../../../../packages/desktop/src/quoteCard.web.ts";

const original = globalThis.OffscreenCanvas;
const drawings = [];
const measureText = (text) => ({ width: Array.from(text).length * 10 });

class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.context = {
      measureText,
      scale() {},
      createLinearGradient: () => ({ addColorStop() {} }),
      fillRect() {},
      beginPath() {},
      roundRect() {},
      fill() {},
      stroke() {},
      fillText(text, x, y) {
        drawings.push({ text, x, y, direction: this.direction });
      },
    };
  }
  getContext() {
    return this.context;
  }
  async convertToBlob(options) {
    assert.equal(options.type, "image/png");

    return new Blob([new Uint8Array([137, 80, 78, 71])]);
  }
}

globalThis.OffscreenCanvas = Canvas;

after(() => {
  globalThis.OffscreenCanvas = original;
});

const card = { text: "Selected passage", title: "Source title", url: "https://example.test/page#:~:text=Selected", colors: ["#31587a"], dark: false };

test("quote cards reject empty, oversized and non-web sources", () => {
  for (const fields of [{ text: "  " }, { text: "x".repeat(4001) }, { url: "file:///tmp/secret" }, { url: "javascript:alert(1)" }, { url: "https://" }]) {
    assert.equal(renderQuoteCard({ ...card, ...fields }), null);
  }

  assert.equal(renderQuoteCard({ ...card, text: "x\n".repeat(1500) }), null, "many short lines cannot allocate an enormous image");
});

test("quote cards render passage and source at 2x with a bounded size", () => {
  drawings.length = 0;
  const canvas = renderQuoteCard(card);
  assert.equal(canvas.width, 1440);
  assert.ok(canvas.height > 400 && canvas.height <= 12668);
  assert.ok(drawings.some(({ text }) => text === card.text));
  assert.ok(drawings.some(({ text }) => text === card.title));
  assert.ok(drawings.some(({ text }) => text === "example.test"));
  assert.ok(drawings.some(({ text }) => text === "Bay"));
});

test("wrapping preserves explicit lines and breaks long words at grapheme boundaries", () => {
  assert.deepEqual(quoteLines({ measureText }, "one two\nthree", 60), ["one", "two", "three"]);
  assert.deepEqual(quoteLines({ measureText }, "abcdefgh", 30), ["abc", "def", "gh"]);
  assert.deepEqual(quoteLines({ measureText }, "👩‍💻👩‍💻", 30), ["👩‍💻", "👩‍💻"]);
});

test("RTL quotes keep their shaping together and align from the right", () => {
  drawings.length = 0;
  const text = "שלום עולם";
  assert.ok(renderQuoteCard({ ...card, text, colors: ["invalid CSS"], dark: true }));
  const passage = drawings.find((draw) => draw.text === text);
  assert.equal(passage.direction, "rtl");
  assert.equal(passage.x, 656);
});

test("copying a web quote sends PNG bytes and its exact text-fragment URL together", async () => {
  const previous = globalThis.nnTestNativeModules;
  const calls = [];
  globalThis.nnTestNativeModules = { BayShell: { copyImage: async (...args) => (calls.push(args), true) } };

  try {
    assert.equal(await quoteCards.copy(card), true);
    assert.deepEqual(calls, [["iVBORw==", card.url]]);
    assert.equal(await quoteCards.copy({ ...card, text: "" }), false);
    assert.equal(calls.length, 1, "invalid cards never change the clipboard");
  } finally {
    globalThis.nnTestNativeModules = previous;
  }
});
