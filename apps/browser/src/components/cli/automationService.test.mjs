// The app's own scripts (components/cli/automationService.ts): the folder the user keeps them in, and the engine
// profiles they are loaded into.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import ts from "typescript";

const code = ts.transpileModule(readFileSync(new URL("./automationService.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const real = createRequire(import.meta.url);

function fixture({ folder = { state: "ready", generation: 1, path: "/data/Scripts/extension", token: "one" }, existing = [] } = {}) {
  const calls = [];
  const statuses = [];

  const state = {
    settings: { cliControl: true },
    spaceOrder: ["default", "shared", "work", "incognito:private"],
    spaces: {
      default: { name: "Personal" },
      shared: { name: "Shared", profileId: "default" },
      work: { name: "Work" },
      "incognito:private": { name: "Private" },
    },
  };

  let current = folder;
  let notice = () => {};
  const installed = new Map();

  for (const profile of ["", "work"])
    installed.set(
      profile,
      existing.map((x) => ({ ...x })),
    );

  const mocks = {
    "@bay/chromium": {
      listExtensions: async (profile) => installed.get(profile) ?? [],
      installExtension: async ({ path }, profile) => {
        calls.push(["install", profile, path]);
        installed.set(profile, [{ id: "scripts", path, enabled: true }]);

        return "scripts";
      },
      reloadExtension: async (id, profile) => {
        calls.push(["reload", profile, id]);
      },
      uninstallExtension: async (id, profile) => {
        calls.push(["uninstall", profile, id]);
        installed.set(
          profile,
          (installed.get(profile) ?? []).filter((x) => x.id !== id),
        );
      },
    },
    "@bay/desktop": {
      onUserScriptsChange: (callback) => {
        notice = callback;

        return { remove() {} };
      },
      readUserScripts: async () => current,
      userScriptsAvailable: () => true,
      watchUserScripts: (on) => calls.push(["watch", on]),
      writeUserScriptsStatus: async (json) => {
        statuses.push(JSON.parse(json));
      },
      installedCliVersion: () => null,
      writeDocument: () => {},
      installCli: async () => ({ ok: false, appVersion: "", error: "not installed", lines: [] }),
      onCliInstallLine: () => ({ remove() {} }),
    },
    "../../store/browserStore": {
      useBrowser: {
        getState: () => state,
        subscribe: () => () => {},
      },
    },
    "../../store/model": {
      isIncognitoSpace: (id) => id.startsWith("incognito:"),
      engineProfile: (id) => (["default", "shared"].includes(id) ? "" : id),
    },
  };

  const module = { exports: {} };
  new Function("require", "module", "exports", "__DEV__", code)(
    (id) => {
      if (id in mocks) return mocks[id];

      return real(id);
    },
    module,
    module.exports,
    false,
  );

  const { AutomationEngine, AutomationService, CliEngine } = module.exports;
  const runtime = ManagedRuntime.make(AutomationService.layer.pipe(Layer.provide(Layer.mergeAll(AutomationEngine.layer, CliEngine.layer))));

  const run = (program) => runtime.runPromise(program);

  const start = () =>
    run(
      Effect.gen(function* () {
        const automation = yield* AutomationService;

        yield* automation.start;
      }),
    );

  const schedule = () =>
    run(
      Effect.gen(function* () {
        const automation = yield* AutomationService;

        yield* automation.schedule;
      }),
    );

  return {
    ...module.exports,
    calls,
    statuses,
    state,
    start,
    schedule,
    setFolder: (value) => {
      current = value;
      notice();
    },
    settled: async () => {
      for (let attempt = 0; attempt < 20; attempt++) await new Promise((resolve) => setImmediate(resolve));
    },
    dispose: () => runtime.dispose(),
  };
}

test("loads once per native profile and reports each public space", async () => {
  const f = fixture();

  await f.start();
  await f.schedule();
  await f.settled();
  assert.deepEqual(
    f.calls.filter((x) => x[0] === "install").map((x) => x[1]),
    ["", "work"],
  );
  assert.deepEqual(f.statuses, [{ version: 1, generation: 1, profiles: { Personal: { ok: true }, Shared: { ok: true }, Work: { ok: true } } }]);
  f.setFolder({ state: "ready", generation: 2, path: "/data/Scripts/extension", token: "two" });
  await f.settled();
  assert.equal(f.calls.filter((x) => x[0] === "install").length, 4);
  assert.equal(f.statuses.at(-1).generation, 2);
  await f.dispose();
});

test("keeps a user-disabled extension disabled while reloading its source", async () => {
  const f = fixture({ existing: [{ id: "scripts", path: "/data/Scripts/extension", enabled: false, state: "DISABLED" }] });

  await f.start();
  await f.schedule();
  await f.settled();
  assert.equal(f.calls.filter((x) => x[0] === "install").length, 0);
  assert.equal(f.calls.filter((x) => x[0] === "reload").length, 2);
  assert.deepEqual(f.statuses[0].profiles.Personal, { disabled: true });
  await f.dispose();
});

test("removes loaded copies when the folder is invalid or uninstalled", async () => {
  for (const state of ["invalid", "absent"]) {
    const f = fixture({
      folder: { state, generation: 2, path: "/data/Scripts/extension", error: "forbidden permissions", token: "two" },
      existing: [{ id: "scripts", path: "/data/Scripts/extension", enabled: true }],
    });

    await f.start();
    await f.schedule();
    await f.settled();
    assert.equal(f.calls.filter((x) => x[0] === "uninstall").length, 2);
    assert.deepEqual(f.statuses[0].profiles.Personal, state === "invalid" ? { error: "forbidden permissions" } : { removed: true });
    await f.dispose();
  }
});

test("does not load scripts while CLI control is disabled", async () => {
  const f = fixture();

  f.state.settings.cliControl = false;
  await f.start();
  await f.schedule();
  await f.settled();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.statuses, []);
  await f.dispose();
});

test("reports spaces whose names match object prototype properties", async () => {
  const f = fixture();

  f.state.spaces.default.name = "__proto__";
  await f.start();
  await f.schedule();
  await f.settled();
  assert.deepEqual(f.statuses[0].profiles.__proto__, { ok: true });
  assert.equal(Object.hasOwn(f.statuses[0].profiles, "__proto__"), true);
  await f.dispose();
});
