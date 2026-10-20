#!/usr/bin/env node
// Runs a converted Firefox XPI in real Chromium, with an isolated hidden Debug Bay instance.
// node packages/import/scripts/firefox-runtime.mjs <built Bay.app> [scratch parent]
// METRO_PORT defaults to 8091; start Metro separately. Tests the adapter runtime, not engine storage hydration.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, sleep } from "../../../scripts/lib/instance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const appPath = resolve(process.argv[2] ?? "apps/browser/build-extension-import/Build/Products/Debug/Bay.app");
const parent = resolve(process.argv[3] ?? tmpdir());
mkdirSync(parent, { recursive: true });
const scratch = mkdtempSync(join(parent, "bay-firefox-runtime-"));
const report = reporter(join(scratch, "runtime.log"), { name: "Firefox compatibility runtime" });
const support = join(scratch, "source");
const profile = join(support, "Firefox/Profiles/runtime");
const extensions = join(profile, "extensions");
const fixture = join(scratch, "fixture");
mkdirSync(extensions, { recursive: true });
mkdirSync(fixture, { recursive: true });
const addonId = "runtime-fixture@example.org";
const files = {
  "manifest.json": JSON.stringify({
    manifest_version: 3,
    name: "Firefox compatibility runtime fixture",
    version: "1.0",
    browser_specific_settings: { gecko: { id: addonId } },
    permissions: ["storage", "menus"],
    background: { scripts: ["background.js"] },
    action: { default_popup: "probe.html" },
  }),
  "background.js": `
browser.runtime.onInstalled.addListener(async () => {
  try {
    const info = await browser.runtime.getBrowserInfo();
    await browser.browserAction.setBadgeText({text: 'FF'});
    const menu = browser.menus.create({id: 'firefox-runtime-menu', title: 'Fixture', contexts: ['all']});
    await browser.storage.local.set({worker: {name: info.name, buildID: info.buildID, menu, url: browser.extension.getURL('probe.html')}});
  } catch (error) {
    await browser.storage.local.set({workerError: String(error)});
  }
});`,
  "probe.html": '<!doctype html><html><head><title>Firefox runtime probe</title></head><body><script src="probe.js"></script></body></html>',
  "probe.js": `
(async () => {
  try {
    const info = await browser.runtime.getBrowserInfo();
    let stored;
    for (let i = 0; i < 100; i++) {
      stored = await browser.storage.local.get(['worker', 'workerError']);
      if (stored.worker || stored.workerError) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const badge = await browser.browserAction.getBadgeText({});
    await browser.menus.remove('firefox-runtime-menu');
    globalThis.runtimeResult = {info, stored, badge, url: browser.extension.getURL('probe.html'), dom: document.title};
  } catch (error) {
    globalThis.runtimeResult = {error: String(error)};
  }
})();`,
};
for (const [name, body] of Object.entries(files)) writeFileSync(join(fixture, name), body);
const xpi = join(extensions, "runtime.xpi");
execFileSync("python3", [
  "-c",
  "import pathlib,sys,zipfile; root=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED); [z.write(p,p.name) for p in root.iterdir()]; z.close()",
  fixture,
  xpi,
]);
writeFileSync(
  join(profile, "extensions.json"),
  JSON.stringify({ addons: [{ id: addonId, type: "extension", location: "app-profile", active: true, path: xpi }] }),
);
writeFileSync(join(support, "Firefox/profiles.ini"), "[Profile0]\nName=Runtime\nIsRelative=1\nPath=Profiles/runtime\nDefault=1\n");
const digest = () => createHash("sha256").update(readFileSync(xpi)).digest("hex");
const originalDigest = digest();
const helper = join(scratch, "prepare-firefox");
const core = join(root, "packages/import/ios/Core");
execFileSync(
  "xcrun",
  [
    "swiftc",
    "-parse-as-library",
    ...readdirSync(core)
      .filter((name) => name.endsWith(".swift"))
      .map((name) => join(core, name)),
    join(root, "packages/import/scripts/prepare-firefox.swift"),
    "-framework",
    "Foundation",
    "-framework",
    "AppKit",
    "-framework",
    "Security",
    "-lsqlite3",
    "-o",
    helper,
  ],
  { timeout: 60_000 },
);
const prepare = () => JSON.parse(execFileSync(helper, [profile, addonId, join(scratch, "owned")], { encoding: "utf8", timeout: 30_000 }));
const prepared = prepare();
const retry = prepare();
assert.equal(prepared.id, retry.id);
assert.notEqual(prepared.path, retry.path);
assert.equal(digest(), originalDigest);
report.record("prepared copies preserve identity and source XPI", { evidence: { id: prepared.id, sourceDigest: originalDigest } });

let app;
let page;
try {
  app = await launch(appPath, {
    data: join(scratch, "data"),
    onboarded: true,
    metroPort: Number(process.env.METRO_PORT ?? 8091),
    env: { BAY_IMPORT_SOURCE_DIR: support },
    ready: { timeout: 60_000, test: "return nn.store.getState().windowOrder.length > 0" },
  });
  report.log({ pid: app.pid, port: app.port, scratch });
  await report.check("converted XPI installs with its stable ID", async () => {
    const result = await app.eval(`return globalThis.expo.modules.BayExtensions.install(${JSON.stringify(prepared.path)}, '')`);
    assert.equal(result.error, undefined);
    assert.equal(result.id, prepared.id);
    return result;
  });
  await report.check("real worker and extension page execute Firefox equivalents", async () => {
    const url = `chrome-extension://${prepared.id}/probe.html`;
    await app.eval(`const store = nn.store.getState(); return store.newTab(store.windowOrder[0], {url: ${JSON.stringify(url)}})`);
    page = await app.page(url, { timeout: 15_000 });
    let result;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      result = await page.eval("globalThis.runtimeResult");
      if (result) break;
      await sleep(100);
    }
    assert.ok(result, "the probe page did not complete");
    report.log(result);
    assert.equal(result.error, undefined);
    assert.equal(result.info.name, "Bay");
    assert.equal(result.info.buildID, "firefox-compat");
    assert.equal(result.stored.workerError, undefined);
    assert.equal(result.stored.worker.name, "Bay");
    assert.equal(result.stored.worker.buildID, "firefox-compat");
    assert.equal(result.stored.worker.menu, "firefox-runtime-menu");
    assert.equal(result.stored.worker.url, url);
    assert.equal(result.url, url);
    assert.equal(result.badge, "FF");
    assert.equal(result.dom, "Firefox runtime probe");
    return result;
  });
  await report.check("new native import clearly reports an older engine", async () => {
    const result = await app.eval(
      `return globalThis.expo.modules.BayImport.writeExtension('firefox', 'Profiles/runtime', ${JSON.stringify(addonId)}, '').then(json => ({reply: JSON.parse(json)})).catch(error => ({error: String(error)}));`,
    );
    if (result.error) assert.match(result.error, /engine does not support extension imports/);
    else assert.equal(result.reply.id, prepared.id);
    return result;
  });
  assert.equal(digest(), originalDigest);
} finally {
  page?.close();
  if (app) report.log("quit", await app.quit());
}
writeFileSync(join(scratch, "results.json"), JSON.stringify(report.results, null, 2));
if (!report.summary()) process.exitCode = 1;
