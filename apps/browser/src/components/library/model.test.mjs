import assert from "node:assert/strict";
import { test } from "node:test";
import { mediaItem, parseEasel, readLibrary, validItem, webLink } from "./model.ts";

const doc = { id: "board", title: "Research", background: "#FFFFFF", spaceId: "default", createdAt: 1, updatedAt: 2, items: [] };
const image = {
  id: "img",
  kind: "image",
  x: -20,
  y: 0,
  width: 300,
  height: 200,
  path: "/data/image.png",
  source: { url: "https://example.com", title: "Source", clip: [10, 20, 300, 200], viewportWidth: 1000, viewportHeight: 800, profileId: "" },
};

test("Library reload preserves geometry, original source crop and default engine profile", () => {
  const board = { ...doc, items: [image] };
  const saved = readLibrary(JSON.stringify({ version: 1, easels: { board }, media: {} }));
  assert.deepEqual(saved.easels.board, board);
  assert.equal(saved.easels.board.items[0].source.profileId, "");
});

test("invalid records cannot pass nonfinite geometry or executable links to canvas/export", () => {
  assert.equal(validItem(image), true);
  for (const patch of [
    { width: -1 },
    { x: Infinity },
    { y: NaN },
    { width: 1e20 },
    { points: [[0, Infinity]] },
    { url: "javascript:alert(1)" },
    { source: { url: "file:///private", title: "x" } },
    { source: { url: "https://example.com", title: "x", clip: [0, 0, 0, 10] } },
  ])
    assert.equal(validItem({ ...image, ...patch }), false, JSON.stringify(patch));
  assert.equal(parseEasel({ ...doc, items: [image, image] }), null);
  assert.equal(webLink("https://example.com/path?q=x"), true);
  assert.equal(webLink("data:text/html,x"), false);
});

test("missing media is skipped, unsupported/corrupt Library is reported without resetting it", () => {
  assert.deepEqual(readLibrary(null), { version: 1, easels: {}, media: {}, removedMediaPaths: [] });
  assert.throws(() => readLibrary("{"));
  assert.throws(() => readLibrary('{"version":2}'));
  assert.deepEqual(readLibrary(JSON.stringify({ version: 1, easels: { wrong: doc }, media: { nope: { id: "nope", path: "/x" } } })).easels, {});
});

test("adding retained media keeps source and aspect and places it beyond existing content", () => {
  const media = { id: "m", name: "Image", path: "/data/a.png", width: 1200, height: 800, createdAt: 1, source: image.source };
  const first = mediaItem(media, [], "one");
  assert.equal(first.width, 560);
  assert.equal(first.width / first.height, 1.5);
  const second = mediaItem(media, [first], "two");
  assert.equal(second.x, first.x + first.width + 32);
  assert.deepEqual(second.source, media.source);
  assert.equal(second.path, media.path);
});

test("live clips compensate for bottom-clamped scrolling and independent resizing", async () => {
  const { liveClipTransform } = await import("./liveClip.ts");
  assert.deepEqual(liveClipTransform([100, 1800, 300, 150], { width: 600, height: 450 }, 1200), { left: -200, top: -1800, scaleX: 2, scaleY: 3 });
  assert.deepEqual(liveClipTransform([100, 250, 320, 180], { width: 320, height: 180 }, 250), { left: -100, top: -0, scaleX: 1, scaleY: 1 });
});
