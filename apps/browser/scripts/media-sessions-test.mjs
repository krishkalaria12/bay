// Actual media playback and native sidebar controls, including three tabs on one host.
// node apps/browser/scripts/media-sessions-test.mjs <Debug Bay.app> [--keep-data]
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, session, sleep } from "../../../scripts/lib/instance.mjs";

const args = process.argv.slice(2);
const appPath = args.find((a) => !a.startsWith("--"));
if (!appPath) throw new Error("Provide the Debug Bay.app path");
const data = mkdtempSync(join(tmpdir(), "bay-media-sessions-"));
const ids = ["one", "two", "three"];
const wav = Buffer.alloc(44 + 44100 * 10 * 2);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(44100, 24);
wav.writeUInt32LE(88200, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < 44100 * 10; i++) wav.writeInt16LE(Math.round(50 * Math.sin((2 * Math.PI * 220 * i) / 44100)), 44 + i * 2);
const server = createServer((req, res) => {
  if (req.url === "/tone.wav") {
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length });
    res.end(wav);
    return;
  }
  const name = req.url.slice(1);
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<title>Track ${name}</title><h1>Track ${name}</h1><audio id="player" controls loop src="/tone.wav"></audio><script>
    const audio = document.querySelector('audio');
    navigator.mediaSession.metadata = new MediaMetadata({title: 'Track ${name}', artist: 'Local fixture'});
    navigator.mediaSession.setActionHandler('play', () => audio.play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  </script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let app;
const pages = new Map();
const until = async (label, fn, timeout = 10000) => {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    if ((last = await fn())) return last;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
};
try {
  app = await launch(resolve(appPath), {
    data,
    session: session({
      settings: { launchTab: "lastTab", autoPictureInPicture: false, newTabPosition: "top" },
      windows: [{ id: "w1", activeTabIds: { default: "one" }, tabIds: ids }],
      tabs: ids.map((id) => ({ id, title: `Track ${id}`, url: `${origin}/${id}` })),
    }),
  });
  const native = `const C = globalThis.expo.modules.BayCEF; const win = () => C.chromeWindows().then(ws => ws.find(w => w.hasRoot).window);`;
  const click = (x, y) => app.eval(`${native} return win().then(n => C.devWindow(n, "click:${x},${y}"));`);
  const shot = (name) => app.eval(`return nn.shell.devSnapshotWindow("w1", ${JSON.stringify(join(data, name + ".png"))});`);
  const state = () => app.eval(`return Object.fromEntries(Object.entries(nn.media.getState().sessions).map(([id, s]) => [id, s.playbackState]));`);
  const actual = async () =>
    Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await pages.get(id).eval("document.querySelector('audio').paused")])));
  for (const id of ids) {
    await app.eval(`nn.actions.switchToTab(${JSON.stringify(id)}); return true;`);
    const page = await app.page(`${origin}/${id}`);
    pages.set(id, page);
    await until(`audio ${id} loaded`, () => page.eval("document.querySelector('audio')?.readyState >= 2"));
    await page.eval("document.querySelector('audio').play().then(() => true)", { userGesture: true });
    await until(`session ${id} playing`, async () => (await state())[id] === "playing");
  }
  assert.deepEqual(await actual(), { one: false, two: false, three: false });
  await sleep(500);
  assert.equal(await shot("three-playing"), true);
  // +2 is the final control on the sidebar player's bottom row.
  await app.eval(`${native} return win().then(n => C.devWindow(n, "fakeActiveClicks"));`);
  const buttonHit = await click(200, 732);
  const list = await until("media list opened from +2", () => app.eval(`return nn.media.getState().sessionList;`));
  const width = 400;
  const height = 56 + ids.length * 48;
  const left = Math.max(8, Math.min(1280 - width - 8, list.anchor.x));
  const top = Math.max(8, Math.min(800 - height - 8, list.anchor.y - height - 8));
  writeFileSync(join(data, "list-geometry.json"), JSON.stringify({ buttonHit, list, left, top }, null, 2));
  assert.equal(await shot("all-sessions"), true);
  const pauseHit = await click(left + 307, top + 24);
  await until("Pause All pauses all actual audio elements", async () => Object.values(await actual()).every(Boolean));
  assert.deepEqual(await actual(), { one: true, two: true, three: true });
  await until("all sessions report paused", async () => Object.values(await state()).length === 3 && Object.values(await state()).every((v) => v === "paused"));
  assert.equal(await shot("all-paused"), true);
  const rowIds = await app.eval(`return Object.keys(nn.media.getState().sessions).filter(id => nn.store.getState().tabs[id]?.windowId === "w1");`);
  const controls = [];
  for (const [index, target] of rowIds.entries()) {
    const rowY = top + 48 + index * 48 + 24;
    const playHit = await click(left + 253, rowY);
    await until(`${target} row starts its own tab`, async () => (await actual())[target] === false);
    const resumed = await actual();
    for (const id of ids) assert.equal(resumed[id], id !== target, `${id} playback after ${target} row Play`);
    await click(left + 253, rowY);
    await until(`${target} row pauses its own tab`, async () => Object.values(await actual()).every(Boolean));
    const muteHit = await click(left + 285, rowY);
    await until(`${target} row mutes its tab`, () => app.eval(`return !!nn.store.getState().tabs[${JSON.stringify(target)}].muted;`));
    const muted = await app.eval(`return Object.fromEntries(Object.entries(nn.store.getState().tabs).map(([id, t]) => [id, t.muted]));`);
    for (const id of ids) assert.equal(muted[id], id === target, `${id} mute after ${target} same-host row control`);
    assert.equal(await app.eval(`return nn.store.getState().settings.mutedSites.includes("127.0.0.1");`), false);
    controls.push({ target, actualPaused: await actual(), muted, playHit, muteHit });
    await click(left + 285, rowY);
    await until(`${target} row unmutes its tab`, () => app.eval(`return !nn.store.getState().tabs[${JSON.stringify(target)}].muted;`));
  }
  const target = rowIds[1];
  const rowY = top + 48 + 48 + 24;
  const goHit = await click(left + 350, rowY);
  await until("Go to Tab selects the row's tab", () => app.eval(`return nn.store.getState().windows.w1.activeTabIds.default === ${JSON.stringify(target)};`));
  assert.equal(await app.eval(`return nn.media.getState().sessionList;`), null);
  assert.equal(await shot("selected-tab"), true);
  writeFileSync(join(data, "results.json"), JSON.stringify({ ids, target, actualPaused: await actual(), controls, pauseHit, goHit }, null, 2));
  console.log(`PASS: three real media tabs, +2 list, native Pause All, individual play/pause/mute and Go to Tab. Evidence: ${data}`);
} finally {
  for (const page of pages.values()) page.close();
  await app?.quit();
  await new Promise((resolve) => server.close(resolve));
  if (!args.includes("--keep-data")) rmSync(data, { recursive: true, force: true });
}
