import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
const script = readFileSync(new URL("../../../../packages/chromium/ios/page_script.js", import.meta.url), "utf8");
const start = script.indexOf("  const audible =");
const end = script.indexOf("  const session =", start);
assert.ok(start > 0 && end > start);
const source = script.slice(start, end);
const media = (patch = {}) => ({ paused: false, ended: false, muted: false, volume: 1, readyState: 4, ...patch });
function page() {
  const videos = [],
    audios = [],
    sent = [],
    queries = [];
  const context = {
    document: {
      getElementsByTagNameNS(namespace, tag) {
        assert.equal(namespace, "*", "prefixed and non-HTML media local names must remain visible");
        queries.push(tag);
        return tag === "video" ? videos : audios;
      },
      querySelectorAll() {
        assert.fail("audibility must not scan the document");
      },
    },
    active: null,
    lastPlaying: null,
    frame: "frame",
    webPlaying: false,
    webAudible: () => context.webPlaying,
    send: (kind, value) => sent.push({ kind, playing: !!value.playing }),
  };
  const report = runInNewContext(`${source}\nreportAudible`, context);
  return { videos, audios, sent, queries, context, report };
}
test("audibility follows insertion, removal and playback without querying the DOM again", () => {
  const p = page();
  p.report();
  const video = media();
  p.videos.push(video);
  p.report();
  for (let i = 0; i < 400; i++) p.report();
  video.paused = true;
  p.report();
  p.audios.push(media());
  p.report();
  p.audios.pop();
  p.report();
  assert.deepEqual(
    p.sent.map((s) => s.playing),
    [false, true, false, true, false],
  );
  assert.deepEqual(p.queries, ["video", "audio"], "collections are acquired once and remain live");
});
test("muted, ended, quiet and unready elements do not mark the tab as audible", () => {
  const p = page();
  p.videos.push(media({ muted: true }), media({ ended: true }), media({ volume: 0 }), media({ readyState: 2 }));
  p.audios.push(media({ paused: true }));
  p.report();
  assert.equal(p.sent.at(-1).playing, false);
  p.videos[0].muted = false;
  p.report();
  assert.equal(p.sent.at(-1).playing, true);
});
test("detached active media and WebAudio remain audible until both stop", () => {
  const p = page();
  p.context.active = media();
  p.report();
  assert.equal(p.sent.at(-1).playing, true);
  p.context.webPlaying = true;
  p.context.active.paused = true;
  p.report();
  assert.equal(p.sent.length, 1, "unchanged speaker state is not emitted twice");
  p.context.active = null;
  p.context.webPlaying = false;
  p.report();
  assert.equal(p.sent.at(-1).playing, false);
});
