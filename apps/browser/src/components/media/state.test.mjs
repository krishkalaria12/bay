// The sidebar player: which tab it shows, and where its play and pause state comes from.
import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../../store/browser.ts");
const { webviews } = await import("../../lib/webviews.ts");
const media = await import("./state.ts");

const S = () => useBrowser.getState();
const M = () => media.useMedia.getState();
const report = (overrides = {}) => ({
  title: "Song", artist: "Band", album: "", artwork: null, playbackState: "playing", position: 10, duration: 200,
  playbackRate: 1, timestamp: Date.now(), hasVideo: false, actions: ["play", "pause"], ...overrides,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

// Two background tabs playing; the player shows the one that started last. As useSidebarPlayerTab does, the player
// passes the tab it shows back in.
async function twoPlaying() {
  S().hydrate({});
  const w = S().createWindow({ url: "a.com" });
  const b = S().newTab(w, { url: "b.com", background: true });
  const c = S().newTab(w, { url: "c.com", background: true });
  const sent = [];
  for (const id of [b, c]) webviews.set(id, { mediaCommand: async (action) => void sent.push([id, action]) });
  media.setNowPlaying(b, report());
  await tick();
  media.setNowPlaying(c, report());
  let shown = media.playerTabFor(M(), [b, c]);
  const player = () => (shown = media.playerTabFor(M(), [b, c], shown));
  return { b, c, sent, player };
}

test("pausing the tab the sidebar player shows keeps the player on it", async () => {
  const { b, c, sent, player } = await twoPlaying();
  assert.equal(player(), c);

  media.mediaCommand(c, "toggle");
  assert.deepEqual(sent, [[c, "toggle"]]);
  assert.equal(M().sessions[c].playbackState, "playing", "nothing changes until the page reports it");
  media.setNowPlaying(c, report({ playbackState: "paused" }));
  assert.equal(player(), c, "paused, while the other tab still plays");

  media.setNowPlaying(c, null);
  assert.equal(player(), b, "its session ended: the next one");
  for (const id of [b, c]) webviews.delete(id);
});

test("a late playing report doesn't move the sidebar player", async () => {
  const { b, c, player } = await twoPlaying();
  assert.equal(player(), c);
  media.mediaCommand(c, "pause");
  const playedAt = M().sessions[c].playedAt;
  // Sent before the page paused, it lands after the click.
  media.setNowPlaying(c, report({ position: 11 }));
  assert.equal(player(), c);
  assert.equal(M().sessions[c].playedAt, playedAt, "still the same play, not a new one");
  media.setNowPlaying(c, report({ playbackState: "paused", position: 11 }));
  assert.equal(player(), c);
  media.setNowPlaying(c, report({ position: 11 }));
  assert.equal(player(), c);
  assert.equal(M().sessions[b].playbackState, "playing");
  for (const id of [b, c]) webviews.delete(id);
});

test("closing the sidebar player hands it to the next tab", async () => {
  const { b, c, player } = await twoPlaying();
  assert.equal(player(), c);
  media.useMedia.setState({ dismissed: { [c]: true } });
  assert.equal(player(), b);
  for (const id of [b, c]) webviews.delete(id);
});

test("a skip goes to the time itself on a site that can seek to one, since its own skip takes its own step", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "a.com" });
  const tab = S().newTab(w, { url: "https://www.youtube.com/watch?v=x", background: true });
  const sent = [];
  webviews.set(tab, { mediaCommand: async (action, seconds) => void sent.push([action, seconds]) });
  const now = Date.now();
  media.setNowPlaying(tab, report({ playbackState: "paused", position: 80, timestamp: now, actions: ["play", "pause", "seekbackward", "seekforward", "seekto"] }));
  media.skip(tab, M().sessions[tab], 15);
  media.skip(tab, M().sessions[tab], -15);
  assert.deepEqual(sent, [["seekTo", 95], ["seekTo", 80]]);
  // Without seekto, the page skips by the seconds asked.
  media.setNowPlaying(tab, report({ playbackState: "paused", position: 5, timestamp: now, actions: ["play", "pause"] }));
  media.skip(tab, M().sessions[tab], -15);
  assert.deepEqual(sent.at(-1), ["seekBy", -15]);
  assert.equal(M().sessions[tab].position, 0, "never before the start");
  webviews.delete(tab);
});

test("automatic Picture in Picture goes off for one site, and on again, as Arc's site switch does", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://www.youtube.com/watch?v=x" });
  const yt = S().windows[w].activeTabIds[S().windows[w].spaceId];
  const other = S().newTab(w, { url: "https://vimeo.com/1", background: true });
  assert.equal(media.autoPictureInPictureFor(S(), yt), true);
  media.setAutoPictureInPictureForSite(yt, false);
  assert.deepEqual(S().settings.noAutoPictureInPictureSites, ["youtube.com"]);
  assert.equal(media.autoPictureInPictureFor(S(), yt), false);
  assert.equal(media.autoPictureInPictureFor(S(), other), true, "other sites keep it");
  media.setAutoPictureInPictureForSite(yt, true);
  assert.deepEqual(S().settings.noAutoPictureInPictureSites, []);
  S().updateSettings({ autoPictureInPicture: false });
  assert.equal(media.autoPictureInPictureFor(S(), other), false, "off in Settings, off everywhere");
});
