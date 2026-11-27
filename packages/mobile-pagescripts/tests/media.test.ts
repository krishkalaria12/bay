import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

import { WATCH_MEDIA_SCRIPT } from "../src/media.ts";

test("only media that can be heard is reported: a muted preview isn't, until it's unmuted", () => {
  const dom = new JSDOM(`<!doctype html><video id="preview" muted src="/preview.mp4"></video>`, { runScripts: "outside-only" });
  const { window } = dom;
  const posts: { playing: boolean }[] = [];
  // SAFETY: page scripts call window.post, which jsdom has no bridge for; this test collects what the watcher reports.
  (window as any).post = (message: { playing: boolean }) => posts.push(message);
  // Page scripts are function bodies (some return early), so each runs wrapped in one, as the apps run them.
  vm.runInContext(`(() => { ${WATCH_MEDIA_SCRIPT}\n })()`, dom.getInternalVMContext());
  // SAFETY: the fixture HTML contains `#preview`, so getElementById can't come back empty for it.
  const preview = window.document.getElementById("preview") as HTMLVideoElement;
  preview.muted = true;
  // jsdom doesn't play media: the element is set as playing and its events sent by hand.
  Object.defineProperty(preview, "paused", { configurable: true, get: () => false });
  preview.dispatchEvent(new window.Event("play"));
  preview.dispatchEvent(new window.Event("playing"));
  assert.deepEqual(posts, []);

  preview.muted = false;
  preview.dispatchEvent(new window.Event("volumechange"));
  assert.deepEqual(
    posts.map((post) => post.playing),
    [true],
  );

  // Muted again while it plays: paused, as far as the player is concerned.
  preview.muted = true;
  preview.dispatchEvent(new window.Event("volumechange"));
  assert.deepEqual(
    posts.map((post) => post.playing),
    [true, false],
  );
});
