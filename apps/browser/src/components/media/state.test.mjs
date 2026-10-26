// The sidebar player: which tab it shows, and where its play and pause state comes from.
import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../../store/browser.ts");
const { webviews } = await import("../../lib/webviews.ts");
const media = await import("./state.ts");

const S = () => useBrowser.getState();
const M = () => media.useMedia.getState();
const report = (overrides = {}) => ({
  title: "Song",
  artist: "Band",
  album: "",
  artwork: null,
  playbackState: "playing",
  position: 10,
  duration: 200,
  playbackRate: 1,
  timestamp: Date.now(),
  hasVideo: false,
  actions: ["play", "pause"],
  live: false,
  liveBehind: 0,
  ...overrides,
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
  media.setNowPlaying(
    tab,
    report({ playbackState: "paused", position: 80, timestamp: now, actions: ["play", "pause", "seekbackward", "seekforward", "seekto"] }),
  );
  media.skip(tab, M().sessions[tab], 15);
  media.skip(tab, M().sessions[tab], -15);
  assert.deepEqual(sent, [
    ["seekTo", 95],
    ["seekTo", 80],
  ]);
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

test("the media list includes playing and paused tabs across spaces, including dismissed and active tabs", () => {
  S().hydrate({});
  media.useMedia.setState({ sessions: {}, dismissed: {} });
  const w = S().createWindow({ url: "active.com" });
  const active = S().windows[w].activeTabIds[S().windows[w].spaceId];
  const paused = S().newTab(w, { url: "paused.com", background: true });
  const ended = S().newTab(w, { url: "ended.com", background: true });
  const otherWindow = S().createWindow({ url: "other.com" });
  const other = S().windows[otherWindow].activeTabIds[S().windows[otherWindow].spaceId];
  media.setNowPlaying(active, report());
  media.setNowPlaying(paused, report({ playbackState: "paused" }));
  media.setNowPlaying(ended, report({ playbackState: "none" }));
  media.setNowPlaying(other, report());
  media.useMedia.setState({ dismissed: { [paused]: true } });
  // A session belongs to this window even when its Space is not the one currently visible.
  S().updateTab(paused, { spaceId: "another-space" });
  assert.deepEqual(media.mediaTabsForWindow(S(), M(), w), [active, paused]);
  S().closeTab(paused);
  assert.deepEqual(media.mediaTabsForWindow(S(), M(), w), [active]);
});

test("Pause All pauses each playing tab once and leaves paused sessions and other windows alone", () => {
  S().hydrate({});
  media.useMedia.setState({ sessions: {}, dismissed: {} });
  const w = S().createWindow({ url: "one.com" });
  const first = S().windows[w].activeTabIds[S().windows[w].spaceId];
  const second = S().newTab(w, { url: "two.com", background: true });
  const third = S().newTab(w, { url: "three.com", background: true });
  const paused = S().newTab(w, { url: "paused.com", background: true });
  const otherWindow = S().createWindow({ url: "other.com" });
  const other = S().windows[otherWindow].activeTabIds[S().windows[otherWindow].spaceId];
  const ids = [first, second, third, paused, other];
  const sent = [];
  for (const id of ids) {
    webviews.set(id, { mediaCommand: async (command) => void sent.push([id, command]) });
    media.setNowPlaying(id, report({ playbackState: id === paused ? "paused" : "playing" }));
  }
  media.useMedia.setState({ dismissed: { [second]: true } });
  media.pauseAllMedia(w);
  assert.deepEqual(sent, [
    [first, "pause"],
    [second, "pause"],
    [third, "pause"],
  ]);
  assert.equal(M().sessions[first].playbackState, "playing", "playback stays authoritative until the page reports its pause");
  // A row's play/pause command only targets that row.
  media.mediaCommand(second, "toggle");
  assert.deepEqual(sent.at(-1), [second, "toggle"]);
  assert.equal(sent.length, 4);
  for (const id of ids) webviews.delete(id);
});

test("muting a media-list row only mutes that tab, even with another session on the same site", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://same.com/one" });
  const first = S().windows[w].activeTabIds[S().windows[w].spaceId];
  const second = S().newTab(w, { url: "https://same.com/two", background: true });
  const sent = [];
  for (const id of [first, second]) webviews.set(id, { setMuted: async (muted) => void sent.push([id, muted]) });
  media.toggleMediaTabMute(second);
  assert.equal(S().tabs[second].muted, true);
  assert.equal(S().tabs[first].muted, false);
  assert.deepEqual(S().settings.mutedSites ?? [], []);
  media.toggleMediaTabMute(second);
  assert.equal(S().tabs[second].muted, false);
  assert.deepEqual(sent, [
    [second, true],
    [second, false],
  ]);
  for (const id of [first, second]) webviews.delete(id);
});

test("a live stream reads Live at its end, and how far behind once it falls back", () => {
  const now = Date.now();
  const live = report({ live: true, liveBehind: 4, duration: 5400, timestamp: now });
  assert.equal(media.liveBehindOf(live, now + 60_000), 0, "playing at 1× near the end stays live");
  assert.equal(media.liveBehindOf(report({ liveBehind: 400, timestamp: now }), now), 0, "a video that isn't live is never behind");
  const paused = { ...live, playbackState: "paused" };
  assert.equal(media.liveBehindOf(paused, now + 20_000), 0, "paused briefly, still within the live edge");
  assert.equal(Math.round(media.liveBehindOf(paused, now + 300_000)), 304, "paused, it falls behind by the time paused");
  assert.equal(Math.round(media.liveBehindOf({ ...live, playbackRate: 0.5 }, now + 120_000)), 64, "at half speed, half as fast");
  assert.equal(media.formatBehind(45), "45s behind");
  assert.equal(media.formatBehind(304), "5m behind");
  assert.equal(media.formatBehind(3600), "1h behind");
  assert.equal(media.formatBehind(3900), "1h 5m behind");
});

test("jumping to live sends the page there and reads Live at once", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://live.com" });
  const tab = S().windows[w].activeTabIds[S().windows[w].spaceId];
  const sent = [];
  webviews.set(tab, { mediaCommand: async (action) => void sent.push(action) });
  media.setNowPlaying(tab, report({ live: true, liveBehind: 600 }));
  media.seekToLive(tab, M().sessions[tab]);
  assert.deepEqual(sent, ["seekToLive"]);
  assert.equal(media.liveBehindOf(M().sessions[tab]), 0);
  webviews.delete(tab);
});
