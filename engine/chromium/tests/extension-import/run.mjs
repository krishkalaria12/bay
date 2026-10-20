#!/usr/bin/env node
// Source-only harness. This builds a small test probe, never Chromium/NNCore.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { binaryOf, binaryPids, commandIsBinary, launch, processInfo, sleep } from "../../../../scripts/lib/instance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const { values: options } = parseArgs({
  options: {
    app: { type: "string" },
    "store-id": { type: "string" },
    help: { type: "boolean" },
  },
});
if (options.help || !options.app) {
  console.log("node engine/chromium/tests/extension-import/run.mjs --app <rebuilt Bay.app> [--store-id <CWS ID requiring permissions>]");
  console.log("Uses temporary profiles and an ad-hoc signed app copy. Builds only the test probe. Optional store check downloads one signed package.");
  process.exit(options.help ? 0 : 1);
}
assert.equal(process.platform, "darwin", "The runtime harness requires macOS");
if (options["store-id"]) assert.match(options["store-id"], /^[a-p]{32}$/);
const out = mkdtempSync(join(tmpdir(), "bay-extension-import-runtime-"));
const appCopy = join(out, "Bay.app");
execFileSync("cp", ["-Rc", resolve(options.app), appCopy]);
let entitlements = execFileSync("codesign", ["-d", "--entitlements", "-", "--xml", appCopy], { encoding: "utf8" });
if (!entitlements.includes("<dict>")) entitlements = '<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>';
for (const key of ["com.apple.security.cs.allow-dyld-environment-variables", "com.apple.security.cs.disable-library-validation"]) {
  const valuePattern = new RegExp(`<key>${key.replaceAll(".", "\\.")}</key>\\s*<(?:true|false)\\s*/>`);
  if (valuePattern.test(entitlements)) entitlements = entitlements.replace(valuePattern, `<key>${key}</key><true/>`);
  else entitlements = entitlements.replace(/<\/dict>\s*<\/plist>\s*$/, `<key>${key}</key><true/></dict></plist>`);
}
const entitlementPath = join(out, "entitlements.plist");
writeFileSync(entitlementPath, entitlements);
execFileSync("codesign", ["--force", "--sign", "-", "--timestamp=none", "--options", "runtime", "--entitlements", entitlementPath, appCopy]);
const probe = join(out, "probe.dylib");
execFileSync("xcrun", [
  "clang",
  "-dynamiclib",
  "-fobjc-arc",
  "-framework",
  "AppKit",
  "-undefined",
  "dynamic_lookup",
  "-I",
  join(repo, "engine/chromium/src"),
  join(here, "probe.m"),
  "-o",
  probe,
]);
execFileSync("codesign", ["--force", "--sign", "-", probe]);

const publicKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" });
const extensionID = [...createHash("sha256").update(publicKey).digest().subarray(0, 16)]
  .flatMap((byte) => [String.fromCharCode(97 + (byte >> 4)), String.fromCharCode(97 + (byte & 15))])
  .join("");
function fixture(name, unlimited) {
  const directory = join(out, name);
  mkdirSync(directory);
  writeFileSync(
    join(directory, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Extension import regression",
      version: "1.0",
      key: publicKey.toString("base64"),
      permissions: ["storage", ...(unlimited ? ["unlimitedStorage"] : [])],
      background: { service_worker: "worker.js" },
      action: { default_popup: "probe.html" },
    }),
  );
  writeFileSync(join(directory, "probe.html"), "<!doctype html><title>Extension import regression</title>");
  writeFileSync(
    join(directory, "worker.js"),
    `const ready = chrome.storage.local.get(["activationCount", "seedKey"]).then(v =>
    chrome.storage.local.set({activationCount:(v.activationCount || 0)+1, observedOnActivation:v.seedKey ?? null}));
    chrome.runtime.onMessage.addListener((message, sender, reply) => { ready.then(() => reply({ready:true})); return true; });`,
  );
  return directory;
}
const sourceExtension = fixture("source-extension", true);
const preparedExtension = fixture("prepared-extension", false);
const sourceData = join(out, "source-data");
const destinationData = join(out, "destination-data");
let sequence = 0;
const live = new Set();
async function start(data, label) {
  const mailbox = join(out, `mailbox-${label}-${++sequence}`);
  mkdirSync(mailbox);
  const binary = binaryOf(appCopy);
  const before = binaryPids(binary);
  let app;
  try {
    app = await launch(appCopy, {
      data,
      js: "none",
      ready: false,
      onboarded: true,
      env: { DYLD_INSERT_LIBRARIES: probe, BAY_EXTENSION_IMPORT_PROBE: mailbox },
    });
  } catch (error) {
    // launch() cannot return an owned instance when DevTools never starts.
    // The unique app copy is ours. Exclude pre-existing test instances and
    // recheck each newly observed process's executable and start time.
    for (const pid of binaryPids(binary)) {
      if (before.has(pid)) continue;
      const original = processInfo(pid);
      const owned = () => {
        const current = processInfo(pid);
        return current && original && current.started === original.started && commandIsBinary(current.command, binary);
      };
      if (owned()) process.kill(pid, "SIGTERM");
      for (const end = Date.now() + 3000; owned() && Date.now() < end; await sleep(100)) {}
      if (owned()) process.kill(pid, "SIGKILL");
    }
    throw error;
  }
  live.add(app);
  async function command(method, args, timeout = 45000) {
    const id = `${label}-${++sequence}`;
    writeFileSync(join(mailbox, "request.json"), JSON.stringify({ id, method, args }));
    for (const end = Date.now() + timeout; Date.now() < end; await sleep(50)) {
      assert(app.alive, `Isolated test app exited; see ${app.log}`);
      try {
        const result = JSON.parse(readFileSync(join(mailbox, "reply.json"), "utf8"));
        if (result.id === id) return result.result;
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
    }
    throw new Error(`${method} timed out; see ${app.log}`);
  }
  return {
    app,
    command,
    async profile(name = "Fixture") {
      const result = await command("profile", { name });
      assert(!result.error, result.error);
      return result.path;
    },
    call(profile, symbol, params = {}, timeout) {
      return command("call", { profile, symbol, params }, timeout);
    },
    async page(profile = "Fixture") {
      const url = `chrome-extension://${extensionID}/probe.html?probe=${++sequence}`;
      const opened = await command("open", { profile, url });
      assert(!opened.error, opened.error);
      const page = await app.page((target) => target.url === url);
      await page.eval("chrome.runtime.sendMessage({ping:true})");
      return page;
    },
    async quit() {
      const result = await app.quit();
      live.delete(app);
      assert.equal(result.how, "quit", `Test instance did not exit cleanly: ${result.how}; see ${app.log}`);
    },
  };
}
async function storage(page) {
  return page.eval(`(async () => ({local:await chrome.storage.local.get(["seedKey","preserve","targetOnly","activationCount","observedOnActivation"]),
    sync:await chrome.storage.sync.get(null)}))()`);
}
async function install(instance, path, profile = "Fixture") {
  const result = await instance.call(profile, "nn_extensions_install", { path });
  assert.equal(result.id, extensionID, result.error);
  return instance.page(profile);
}
function stripInstalledProfile(profile) {
  // Only our stopped disposable target. Keep its orphaned settings to prove
  // missing-key merge preserves destination values on a new installation.
  for (const name of ["Preferences", "Secure Preferences"]) {
    const path = join(profile, name);
    if (!existsSync(path)) continue;
    const preferences = JSON.parse(readFileSync(path, "utf8"));
    if (preferences.extensions?.settings) delete preferences.extensions.settings[extensionID];
    writeFileSync(path, JSON.stringify(preferences));
  }
}
function digest(directory) {
  const entries = {};
  function walk(path, relative = "") {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const rel = join(relative, entry.name),
        absolute = join(path, entry.name);
      if (entry.isDirectory()) walk(absolute, rel);
      else if (entry.isFile()) entries[rel] = createHash("sha256").update(readFileSync(absolute)).digest("hex");
    }
  }
  walk(directory);
  return entries;
}
async function check(name, fn) {
  await fn();
  console.log(`PASS ${name}`);
}
try {
  const source = await start(sourceData, "source");
  const sourceProfile = await source.profile();
  const sourcePage = await install(source, sourceExtension);
  await sourcePage.eval(`(async () => {await chrome.storage.local.set({seedKey:"source",preserve:"source"});
    await chrome.storage.sync.set({syncKey:"source",syncPreserve:"source"});})()`);
  const targetSeed = await start(destinationData, "target-seed");
  const destinationProfile = await targetSeed.profile();
  const seedPage = await install(targetSeed, preparedExtension);
  await seedPage.eval(`(async () => {await chrome.storage.local.set({preserve:"target",targetOnly:true});
    await chrome.storage.sync.set({syncPreserve:"target"});})()`);
  seedPage.close();
  await targetSeed.quit();
  stripInstalledProfile(destinationProfile);
  let destination = await start(destinationData, "destination");
  await destination.profile();
  const args = {
    id: extensionID,
    sourceId: extensionID,
    sourceProfilePath: sourceProfile,
    path: preparedExtension,
    store: false,
    enabled: true,
    pinned: true,
    source: "chromium",
  };
  await check("live source DB refuses snapshot before installing", async () => {
    const result = await destination.call("Fixture", "nn_extensions_import", args);
    assert(result.error?.includes("consistent settings snapshot"), JSON.stringify(result));
    assert(!result.retainsPath);
    const list = await destination.call("Fixture", "nn_extensions_list");
    assert(!list.extensions.some((item) => item.id === extensionID));
  });
  sourcePage.close();
  await source.quit();
  const sourceBefore = digest(sourceProfile);
  await check("storage merges before first background execution", async () => {
    const result = await destination.call("Fixture", "nn_extensions_import", args);
    assert.equal(result.installed, true, result.error);
    assert(result.storageImported > 0);
    assert.equal(result.updateMode, "local");
    const page = await destination.page();
    const values = await storage(page);
    assert.equal(values.local.seedKey, "source");
    assert.equal(values.local.preserve, "target");
    assert.equal(values.local.targetOnly, true);
    assert.equal(values.local.observedOnActivation, "source");
    assert.equal(values.local.activationCount, 2);
    assert.equal(values.sync.syncKey, "source");
    assert.equal(values.sync.syncPreserve, "target");
    await page.eval('chrome.storage.local.set({preserve:"edited",seedKey:"destination"})');
    const repeat = await destination.call("Fixture", "nn_extensions_import", args);
    assert.equal(repeat.installed, false);
    assert.equal(repeat.storageImported, 0);
    assert.equal((await storage(page)).local.seedKey, "destination");
    assert.equal((await storage(page)).local.preserve, "edited");
    page.close();
    assert.deepEqual(digest(sourceProfile), sourceBefore, "Importer modified source files");
  });
  await check("source-disabled extension stays off and keeps its pin", async () => {
    await destination.profile("Disabled");
    const result = await destination.call("Disabled", "nn_extensions_import", { ...args, enabled: false });
    assert.equal(result.installed, true, result.error);
    let item = (await destination.call("Disabled", "nn_extensions_list")).extensions.find((entry) => entry.id === extensionID);
    assert.equal(item.enabled, false);
    const enabled = await destination.call("Disabled", "nn_extensions_set_enabled", { id: extensionID, enabled: true });
    assert(!enabled.error, enabled.error);
    const page = await destination.page("Disabled");
    assert.equal((await storage(page)).local.activationCount, 2, "Background ran while disabled");
    item = (await destination.call("Disabled", "nn_extensions_list")).extensions.find((entry) => entry.id === extensionID);
    assert.equal(item.pinned, true);
    page.close();
  });
  await check("failed hydration keeps code disabled and retry releases only the import hold", async () => {
    const largeSource = await start(sourceData, "large-source");
    await largeSource.profile();
    const page = await largeSource.page();
    await page.eval('chrome.storage.local.set({largePayload:"x".repeat(11*1024*1024)})', { timeout: 30000 });
    page.close();
    await largeSource.quit();
    await destination.profile("QuotaHold");
    const failed = await destination.call("QuotaHold", "nn_extensions_import", args);
    assert(failed.error?.includes("extension remains disabled"), JSON.stringify(failed));
    assert.equal(failed.retainsPath, true);
    await destination.quit();
    destination = await start(destinationData, "destination-restarted");
    await destination.profile("QuotaHold");
    const restoredHold = (await destination.call("QuotaHold", "nn_extensions_list")).extensions.find((entry) => entry.id === extensionID);
    assert.equal(restoredHold.enabled, false, "Pending hydration hold disappeared after restart");
    const attempt = await destination.call("QuotaHold", "nn_extensions_set_enabled", { id: extensionID, enabled: true });
    assert(!attempt.error, attempt.error);
    const held = (await destination.call("QuotaHold", "nn_extensions_list")).extensions.find((entry) => entry.id === extensionID);
    assert.equal(held.enabled, false, "Explicit enable bypassed import hold");
    const repair = await start(sourceData, "repair-source");
    await repair.profile();
    const repairPage = await repair.page();
    await repairPage.eval('chrome.storage.local.remove("largePayload")');
    const repaired = await storage(repairPage);
    repairPage.close();
    await repair.quit();
    const resumed = await destination.call("QuotaHold", "nn_extensions_import", args);
    assert.equal(resumed.installed, false, resumed.error);
    const resumedPage = await destination.page("QuotaHold");
    const values = await storage(resumedPage);
    assert.equal(values.local.observedOnActivation, "source");
    assert.equal(values.local.activationCount, repaired.local.activationCount + 1, "Code executed before hydration completed");
    resumedPage.close();
  });
  if (options["store-id"])
    await check("official signed CWS package keeps updater identity and requires unknown grants review", async () => {
      await destination.profile("Store");
      const id = options["store-id"];
      const result = await destination.call(
        "Store",
        "nn_extensions_import",
        { id, sourceId: "store-fixture@tests.invalid", source: "firefox", sourceProfilePath: sourceProfile, store: true, enabled: true, pinned: true },
        160000,
      );
      assert.equal(result.installed, true, result.error);
      assert.equal(result.id, id);
      assert.equal(result.updateMode, "store");
      const item = (await destination.call("Store", "nn_extensions_list")).extensions.find((entry) => entry.id === id);
      assert.equal(item.location, "FROM_STORE");
      assert.equal(item.enabled, false, "Choose a CWS extension that requires permissions");
      assert(result.warnings.some((warning) => warning.includes("permissions")));
      await destination.quit();
      destination = await start(destinationData, "store-restarted");
      await destination.profile("Store");
      const afterRestart = (await destination.call("Store", "nn_extensions_list")).extensions.find((entry) => entry.id === id);
      assert.equal(afterRestart.enabled, false, "Permission review hold disappeared after hydration and restart");
    });
  await destination.quit();
  console.log(`Runtime regression passed. Isolated artifacts and logs: ${out}`);
} catch (error) {
  console.error(`Runtime regression failed. Artifacts: ${out}`);
  throw error;
} finally {
  for (const app of live) await app.quit().catch((error) => console.error(error.message));
}
