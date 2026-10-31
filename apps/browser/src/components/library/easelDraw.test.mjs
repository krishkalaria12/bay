import test from "node:test";
import assert from "node:assert/strict";
import { boundedScale, drawItem } from "../../../../../packages/shell/src/easelDraw.ts";

/** Records what's drawn; a character is 10 wide. */
function recorder() {
  const calls = [];
  const record =
    (name) =>
    (...args) =>
      void calls.push([name, ...args]);
  const context = { measureText: (text) => ({ width: text.length * 10 }) };
  for (const name of [
    "save",
    "restore",
    "beginPath",
    "moveTo",
    "lineTo",
    "stroke",
    "strokeRect",
    "fillRect",
    "fillText",
    "ellipse",
    "rect",
    "clip",
    "drawImage",
  ])
    context[name] = record(name);
  return { context, calls, named: (name) => calls.filter((c) => c[0] === name) };
}
const base = { id: "i", x: 10, y: 20, width: 100, height: 50 };
const none = () => null;

test("text wraps to its box, keeps its line breaks, and stops at the bottom", () => {
  const { context, named } = recorder();
  drawItem(context, { ...base, kind: "text", text: "one two three\nfour", fontSize: 10 }, none);
  assert.deepEqual(
    named("fillText").map((c) => c[1]),
    ["one two", "three", "four"],
  );
  const tall = recorder();
  drawItem(tall.context, { ...base, height: 20, kind: "text", text: "a\nb\nc\nd", fontSize: 10 }, none);
  assert.equal(tall.named("fillText").length, 2);
});

test("a link draws its box and insets its text", () => {
  const { context, named } = recorder();
  drawItem(context, { ...base, kind: "link", url: "https://a.example/" }, none);
  assert.equal(named("strokeRect").length, 1);
  assert.equal(named("fillText")[0][2], 22);
});

test("an image draws at its place; one that's missing says so", () => {
  const picture = {};
  const drawn = recorder();
  drawItem(drawn.context, { ...base, kind: "image", path: "/a.png" }, () => picture);
  assert.deepEqual(drawn.named("drawImage")[0], ["drawImage", picture, 10, 20, 100, 50]);
  const missing = recorder();
  drawItem(missing.context, { ...base, width: 300, kind: "image", path: "/a.png" }, none);
  assert.equal(missing.named("fillText")[0][1], "Image unavailable");
});

test("shapes, strokes and arrowheads", () => {
  const ellipse = recorder();
  drawItem(ellipse.context, { ...base, kind: "ellipse" }, none);
  assert.deepEqual(ellipse.named("ellipse")[0].slice(1, 5), [60, 45, 50, 25]);
  const dot = recorder();
  drawItem(dot.context, { ...base, kind: "pen", points: [[0, 0]] }, none);
  assert.equal(dot.named("lineTo").length, 1, "a single point still marks");
  const arrow = recorder();
  drawItem(
    arrow.context,
    {
      ...base,
      kind: "arrow",
      points: [
        [0, 0],
        [100, 50],
      ],
    },
    none,
  );
  assert.equal(arrow.named("stroke").length, 2);
  assert.equal(arrow.named("lineTo").length, 3, "the shaft and the head's two sides");
});

test("an export stays within what a canvas can hold", () => {
  assert.equal(boundedScale(1000, 1000), 1);
  assert.equal(boundedScale(32768, 100), 0.5);
  const scale = boundedScale(10000, 10000);
  assert.ok(10000 * scale * 10000 * scale <= 32_000_000 + 1);
});
