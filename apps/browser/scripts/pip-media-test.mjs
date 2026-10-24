// The floating video's speed, subtitles and Live controls, and Live in the sidebar player, on a real video in Chrome's
// Picture in Picture window. The fixture is a canvas stream that acts as a live stream that can be rewound: its
// seekable end keeps moving, and seeking back puts it behind.
// node apps/browser/scripts/pip-media-test.mjs <Debug Bay.app> [--keep-data]
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, session, sleep } from "../../../scripts/lib/instance.mjs";

const args = process.argv.slice(2);
const appPath = args.find((a) => !a.startsWith("--"));
if (!appPath) throw new Error("Provide the Debug Bay.app path");
const data = mkdtempSync(join(tmpdir(), "bay-pip-media-"));
const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  if (req.url !== "/live") return res.end("<title>Other</title>Other");
  res.end(`<title>Live fixture</title><video id="v" playsinline style="width: 320px; height: 180px"></video><script>
    const v = document.getElementById("v");
    const c = document.createElement("canvas"); c.width = 320; c.height = 180;
    const g = c.getContext("2d"); let n = 0;
    setInterval(() => { g.fillStyle = "hsl(" + ((n++ * 7) % 360) + ", 70%, 50%)"; g.fillRect(0, 0, 320, 180); }, 33);
    // A stream whose end moves with the clock, played 3 s behind it, which a seek moves.
    const started = performance.now();
    const end = () => 600 + (performance.now() - started) / 1000;
    let behind = 3;
    Object.defineProperty(v, "duration", { get: end });
    Object.defineProperty(v, "seekable", { get: () => ({ length: 1, start: () => 0, end }) });
    Object.defineProperty(v, "currentTime", { get: () => end() - behind, set: (t) => (behind = Math.max(0, end() - t)) });
    window.seekBack = (seconds) => { behind = seconds; v.dispatchEvent(new Event("seeked")); return true; };
    window.behind = () => behind;
    for (const [label, language, text] of [["English", "en", "Hello from Bay"], ["French", "fr", "Bonjour de Bay"]]) {
      const track = v.addTextTrack("subtitles", label, language);
      track.mode = "disabled";
      track.addCue(new VTTCue(0, 36000, text));
    }
    navigator.mediaSession.metadata = new MediaMetadata({ title: "Live fixture", artist: "Bay" });
    window.start = () => {
      const stream = c.captureStream(30);
      // Sound the page script counts as heard, too quiet to hear.
      const ac = new AudioContext(), osc = ac.createOscillator(), gain = ac.createGain(), out = ac.createMediaStreamDestination();
      gain.gain.value = 0.0001;
      osc.connect(gain).connect(out); osc.start();
      stream.addTrack(out.stream.getAudioTracks()[0]);
      v.srcObject = stream;
      return v.play().then(() => "ok", (e) => e.name);
    };
  </script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let app;
let page;
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
      settings: { launchTab: "lastTab", autoPictureInPicture: false },
      windows: [{ id: "w1", activeTabIds: { default: "live" }, tabIds: ["live", "other"] }],
      tabs: [
        { id: "live", title: "Live fixture", url: `${origin}/live` },
        { id: "other", title: "Other", url: `${origin}/other` },
      ],
    }),
  });
  const cef = (call) => app.eval(`return globalThis.expo.modules.BayCEF.${call};`);
  const pip = async () => (await cef("devPictureInPicture()")).find((w) => w.video && w.styled) ?? null;
  const action = (name) => cef(`devPictureInPictureAction(${JSON.stringify(name)})`);
  const media = () => app.eval(`return nn.media.getState().sessions.live ?? null;`);
  const shot = (name) => app.eval(`return nn.shell.devSnapshotWindow("w1", ${JSON.stringify(join(data, name + ".png"))});`);

  page = await app.page(`${origin}/live`);
  assert.equal(await page.eval("start()", { userGesture: true }), "ok");
  // Its end is seen moving for 2 s before it counts as live.
  const live = await until("the session reads live", async () => ((await media())?.live ? media() : null));
  assert.ok(live.liveBehind < 30, `near the end: ${live.liveBehind}`);

  assert.equal(await app.eval(`return nn.webviews.get("live").requestPictureInPicture();`), true);
  const shown = await until("Chrome's PiP window with our controls", async () => ((await pip())?.live === "Live" ? pip() : null));
  assert.equal(shown.speed, "1×");
  assert.equal(shown.subtitles, "captions.bubble", "the video has subtitles");
  assert.equal(shown.caption, "");

  // Speed.
  assert.equal(await action("speedMenu"), "0.5×|0.75×|✓1×|1.25×|1.5×|1.75×|2×");
  await action("rate:1.5");
  await until("the page plays at 1.5×", () => page.eval("v.playbackRate === 1.5"));
  await until("the window reads 1.5×", async () => (await pip())?.speed === "1.5×");
  assert.ok((await action("speedMenu")).includes("✓1.5×"));

  // Subtitles: the chosen track shows in the page, and its text in the window.
  assert.equal(await action("subtitlesMenu"), "✓Off|English|French");
  await action("subtitles:0");
  await until("English shows in the page", () => page.eval('v.textTracks[0].mode === "showing" && v.textTracks[1].mode === "disabled"'));
  const english = await until("the window draws English", async () => ((await pip())?.caption === "Hello from Bay" ? pip() : null));
  assert.equal(english.subtitles, "captions.bubble.fill");
  await action("subtitles:1");
  await until("the window draws French", async () => (await pip())?.caption === "Bonjour de Bay");
  assert.equal(await page.eval("v.textTracks[0].mode"), "disabled");
  await action("subtitles:-1");
  await until("subtitles off", async () => (await pip())?.caption === "" && (await page.eval("[...v.textTracks].every((t) => t.mode === 'disabled')")));

  // Behind live, and back.
  await page.eval("seekBack(300)");
  await until("the window reads 5m behind", async () => (await pip())?.live === "5m behind");
  await until("the session reads 300 s behind", async () => Math.abs(((await media())?.liveBehind ?? 0) - 300) <= 2);
  await action("showControls");
  const behind = await pip();
  await action("live");
  await until("the page is back at its end", async () => (await page.eval("behind()")) < 30);
  await until("the window reads Live", async () => (await pip())?.live === "Live");

  // The sidebar player, for the tab in the background.
  await page.eval("seekBack(300)");
  await until("the session reads behind again", async () => ((await media())?.liveBehind ?? 0) >= 290);
  await app.eval(`nn.actions.switchToTab("other"); return true;`);
  await sleep(600);
  assert.equal(await shot("sidebar-behind"), true);
  // As the sidebar's "5m behind" does.
  await app.eval(`nnMedia.seekToLive("live", nn.media.getState().sessions.live); return true;`);
  await until("the sidebar's jump puts the page at its end", async () => (await page.eval("behind()")) < 30);
  await until("the session reads live again", async () => ((await media())?.liveBehind ?? 99) < 30);
  await sleep(600);
  assert.equal(await shot("sidebar-live"), true);

  await app.eval(`return nn.webviews.get("live").exitPictureInPicture();`);
  writeFileSync(join(data, "results.json"), JSON.stringify({ live, shown, english, behind }, null, 2));
  console.log(`PASS: PiP speed, subtitles and Live, and Live in the sidebar player. Evidence: ${data}`);
} finally {
  page?.close();
  await app?.quit();
  await new Promise((resolve) => server.close(resolve));
  if (!args.includes("--keep-data")) rmSync(data, { recursive: true, force: true });
}
