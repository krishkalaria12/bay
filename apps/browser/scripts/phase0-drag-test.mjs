// Phase 0: a tab torn off by AppKit mouse events keeps its live document, including from an acted fullscreen window.
// node apps/browser/scripts/phase0-drag-test.mjs <Debug Bay.app> <scratch dir>
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch, reporter, session, sleep } from "../../../scripts/lib/instance.mjs";

const [appArg, scratchArg] = process.argv.slice(2);
if (!appArg || !scratchArg) throw new Error("usage: phase0-drag-test.mjs <Debug Bay.app> <scratch dir>");
const scratch = resolve(scratchArg);
mkdirSync(scratch, { recursive: true });
const report = reporter(join(scratch, "phase0-drag.log"), { name: "phase0-drag" });
const results = [];
const requests = new Map();
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://fixture").pathname;
  requests.set(path, (requests.get(path) ?? 0) + 1);
  if (path === "/favicon.ico") {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  res.end(`<!doctype html><title>${path.slice(1)}</title><body style="margin:0;height:10000px">
    <input id="draft" value="original"><h1>Drag fixture</h1>
    <script>window.documentNonce = Math.random().toString(36);</script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const until = async (description, fn) => {
  for (const end = Date.now() + 20000; Date.now() < end; await sleep(100)) {
    const result = await fn();
    if (result) return result;
  }
  throw new Error(`timed out waiting for ${description}`);
};

let app;
try {
  for (const mode of ["normal", "acted-fullscreen"]) {
    await report.check(`tear-off preserves document in ${mode}`, async () => {
      const path = `/${mode}`;
      app = await launch(resolve(appArg), {
        data: join(scratch, mode),
        fresh: true,
        onboarded: true,
        session: session({
          settings: { tabLayout: "top", launchTab: "lastTab", warnBeforeClosingLastTab: false },
          windows: [{ id: "w1", activeTabIds: { default: "live" }, frame: [80, 20, 1000, 700] }],
          tabs: [
            { id: "live", url: `${base}${path}`, title: mode },
            { id: "spare", url: `${base}/spare-${mode}`, title: "spare" },
          ],
        }),
      });
      try {
        await app.eval(`nn.developer.setDeveloperMode(${JSON.stringify(base)}, false); return true`);
        await until("the live tab loaded", () => app.eval('return !!nn.webviews.get("live") && nn.store.getState().live.live?.isLoading === false'));
        const page = await app.page(path);
        let before;
        try {
          await page.eval('scrollTo(0, 2300); document.getElementById("draft").value = "unsaved draft"; true');
          await sleep(300);
          before = await page.eval('({ nonce: window.documentNonce, scroll: scrollY, draft: document.getElementById("draft").value })');
        } finally {
          page.close();
        }
        assert.equal(before.scroll, 2300);
        const targetBefore = await app.pageTarget(path);
        const browserBefore = await app.eval('return Object.entries(nn.pageState.getState().browsers).find(([, tab]) => tab === "live")?.[0]');
        const loadsBefore = requests.get(path);
        const native = `const C = globalThis.expo.modules.BayCEF; const win = () => C.chromeWindows().then(ws => ws.find(w => w.hasRoot).window);`;
        let fullscreen = null;
        if (mode === "acted-fullscreen") {
          fullscreen = JSON.parse(await app.eval(`${native} return win().then(n => C.devWindow(n, "fakeFullScreen:1"))`));
          assert.equal(fullscreen.acted, true);
          assert.equal(fullscreen.chromeCounts, true);
          assert.equal(fullscreen.fullScreen, true);
          assert.equal(fullscreen.styleMask, false, "the test does not enter a macOS Space");
        }
        // Find only the two tab runs. The fixture has one space and no restored or startup tabs.
        const items = await app.eval(`${native} return win().then(n => {
          const xs = Array.from({ length: 740 }, (_, i) => i + 110);
          return Promise.all(xs.map(x => C.devWindow(n, "hit:" + x + ",21"))).then(hits => {
            const runs = []; let current = null;
            hits.forEach((hit, i) => { const on = /ContextMenuArea|ImageView|Symbol|FadeLabel/.test(hit);
              if (on && !current) current = [xs[i], xs[i]]; else if (on) current[1] = xs[i];
              else if (current) { runs.push(current); current = null; } });
            if (current) runs.push(current); return runs;
          });
        })`);
        assert.equal(items.length, 2, `two top-strip tabs: ${JSON.stringify(items)}`);
        const x = Math.round((items[0][0] + items[0][1]) / 2);
        await app.eval(`${native} return win().then(n => C.devWindow(n, "windowDrags"))`);
        const hit = await app.eval(`${native} return win().then(n => C.devWindow(n, "drag:${x},21;${x},-40;${x + 80},-90"))`);
        const moved = await until("the live tab in a new window", () =>
          app.eval(`const s = nn.store.getState();
          const w = Object.values(s.windows).find(w => w.id !== "w1" && w.activeTabIds[w.spaceId] === "live");
          return w && s.tabs.live.windowId === w.id ? { id: w.id, count: Object.keys(s.windows).length, active: w.activeTabIds[w.spaceId] } : null`),
        );
        assert.equal(moved.count, 2);
        await until("the moved native page mounted", () => app.eval('return !!nn.webviews.get("live") && nn.store.getState().live.live?.isLoading === false'));
        await sleep(1000);
        const afterPage = await app.page(path);
        let after;
        try {
          after = await afterPage.eval('({ nonce: window.documentNonce, scroll: scrollY, draft: document.getElementById("draft").value })');
        } finally {
          afterPage.close();
        }
        const targetAfter = await app.pageTarget(path);
        const browserAfter = await app.eval('return Object.entries(nn.pageState.getState().browsers).find(([, tab]) => tab === "live")?.[0]');
        assert.deepEqual(after, before, "nonce, scroll and unsaved form survive");
        assert.equal(targetAfter.id, targetBefore.id, "the same DevTools document target survives");
        assert.equal(browserAfter, browserBefore, "the same native tab survives");
        assert.equal(requests.get(path), loadsBefore, "no HTTP document reload");
        const windowDrags = await app.eval(`${native} return win().then(n => C.devWindow(n, "windowDrags"))`);
        assert.equal(Number(windowDrags.split("\n")[0]), 0, "the tab gesture does not move its window");
        const evidence = {
          mode,
          fullscreen,
          hit,
          items,
          moved,
          before,
          after,
          target: targetAfter.id,
          browser: browserAfter,
          documentRequests: requests.get(path),
        };
        results.push(evidence);
        return evidence;
      } finally {
        await app?.quit();
        app = null;
      }
    });
  }
} finally {
  await app?.quit();
  server.close();
  writeFileSync(join(scratch, "results.json"), JSON.stringify({ passed: report.failed.length === 0, results, failures: report.failed }, null, 2));
}
process.exitCode = report.summary() ? 0 : 1;
