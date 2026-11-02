import { createServer } from "node:http";
import { mkdirSync, writeFileSync, realpathSync, cpSync, mkdtempSync, existsSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, session, sleep } from "../../../../scripts/lib/instance.mjs";
// node media-events.mjs <Release Bay.app> [page_script.js] [output directory]
// Synthetic stress fixture: media metadata events with 200 media elements and 0/20k unrelated DOM nodes.
// Each round includes all installed page-script event handlers; scanMs counts only querySelectorAll itself.
const [appArg, scriptArg, outArg] = process.argv.slice(2);
if (!appArg) throw new Error("usage: media-events.mjs <Release Bay.app> [page_script.js] [output directory]");
const out = resolve(outArg ?? mkdtempSync(join(tmpdir(), "bay-media-events-")));
mkdirSync(out, { recursive: true });
const canonicalOut = realpathSync(out);
const clone = join(canonicalOut, "Bay.app");
if (existsSync(clone)) throw new Error(`Use a fresh output directory: ${clone} already exists`);
const sourceApp = realpathSync(resolve(appArg));
execFileSync("cp", ["-cR", sourceApp, clone]);
if (!lstatSync(clone).isDirectory() || realpathSync(clone) === sourceApp) throw new Error("App clone is not independent");
const pageScript = scriptArg ? resolve(scriptArg) : fileURLToPath(new URL("../../../../packages/chromium/ios/page_script.js", import.meta.url));
const resource = realpathSync(join(clone, "Contents/Resources/page_script.js"));
if (!resource.startsWith(realpathSync(clone) + "/")) throw new Error("Page-script resource escapes the app clone");
cpSync(pageScript, resource);
const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end("<!doctype html><title>Media performance fixture</title><body></body>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/media-perf`;
let app, page;
try {
  app = await launch(clone, {
    data: canonicalOut + "/data-" + Date.now(),
    js: "none",
    probe: true,
    onboarded: true,
    session: session({
      settings: { launchTab: "lastTab" },
      windows: [{ id: "w1", activeTabIds: { default: "one" }, tabIds: ["one"] }],
      tabs: [{ id: "one", url, title: "Fixture" }],
    }),
    ready: "return !!nn.store",
  });
  page = await app.page("/media-perf");
  await sleep(700);
  const result = await page.eval(`
(async () => {
    const results = [];
    for (const nodes of [0, 20000]) {
        document.body.replaceChildren();
        const fragment = document.createDocumentFragment();
        for (let i = 0; i < nodes; i++) {
            const div = document.createElement('div');
            div.textContent = 'feed item ' + i;
            fragment.append(div);
        }
        for (let i = 0; i < 200; i++)
            fragment.append(document.createElement(i % 2 ? 'video' : 'audio'));
        document.body.append(fragment);
        const media = [...document.querySelectorAll('video,audio')];
        const original = Document.prototype.querySelectorAll;
        let scans = 0, scanMs = 0;
        Document.prototype.querySelectorAll = function (selector) { const t = performance.now(); const result = original.call(this, selector); if (selector === 'video,audio') {
            scans++;
            scanMs += performance.now() - t;
        } return result; };
        const samples = [];
        for (let r = 0; r < 7; r++) {
            const start = performance.now();
            for (let i = 0; i < 400; i++)
                media[i % media.length].dispatchEvent(new Event('loadedmetadata'));
            samples.push(performance.now() - start);
            await new Promise(r => setTimeout(r, 200));
        }
        Document.prototype.querySelectorAll = original;
        samples.sort((a, b) => a - b);
        results.push({ nodes, media: media.length, eventsPerRound: 400, medianMs: samples[3], scans, scanMs });
    }
    return results;
})();
`);
  await page.eval(
    `document.body.replaceChildren(); globalThis.testVideo=document.createElement('video'); globalThis.testPaused=false; Object.defineProperties(testVideo,{paused:{get:()=>testPaused},readyState:{get:()=>4}}); document.body.append(testVideo); testVideo.dispatchEvent(new Event('playing')); true`,
  );
  for (let i = 0; i < 40 && !(await app.eval("return !!nn.store.getState().live.one?.playingAudio")); i++) await sleep(50);
  if (!(await app.eval("return !!nn.store.getState().live.one?.playingAudio"))) throw new Error("speaker state did not become audible");
  await page.eval(`testPaused=true;testVideo.dispatchEvent(new Event('pause'));true`);
  for (let i = 0; i < 40 && (await app.eval("return !!nn.store.getState().live.one?.playingAudio")); i++) await sleep(50);
  if (await app.eval("return !!nn.store.getState().live.one?.playingAudio")) throw new Error("speaker state did not clear");
  // A qualified tag name is still a native media element and matches the old CSS local-name query.
  const prefixed = await page.eval(`(() => {
    testPaused = true; testVideo.dispatchEvent(new Event('pause'));
    const video = document.createElementNS('http://www.w3.org/1999/xhtml', 'h:video');
    Object.defineProperties(video, {paused:{get:()=>false},readyState:{get:()=>4}});
    document.body.append(video);
    testVideo.dispatchEvent(new Event('loadedmetadata'));
    globalThis.prefixedTestVideo = video;
    return {native:video instanceof HTMLMediaElement, matched:document.querySelectorAll('video').length,
      byQualified:document.getElementsByTagName('video').length, byLocal:document.getElementsByTagNameNS('*','video').length};
  })()`);
  if (!prefixed.native || prefixed.byLocal !== prefixed.matched || prefixed.byQualified >= prefixed.matched)
    throw new Error("prefixed fixture did not exercise namespace matching");
  for (let i = 0; i < 40 && !(await app.eval("return !!nn.store.getState().live.one?.playingAudio")); i++) await sleep(50);
  if (!(await app.eval("return !!nn.store.getState().live.one?.playingAudio"))) throw new Error("prefixed media was lost from audibility");
  await page.eval(`prefixedTestVideo.remove();testVideo.dispatchEvent(new Event('pause'));true`);
  for (let i = 0; i < 40 && (await app.eval("return !!nn.store.getState().live.one?.playingAudio")); i++) await sleep(50);
  if (await app.eval("return !!nn.store.getState().live.one?.playingAudio")) throw new Error("removed prefixed media remained audible");
  console.log("Native speaker-state and prefixed-media integration passed");
  writeFileSync(join(canonicalOut, "results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  page?.close();
  await app?.quit();
  server.close();
}
