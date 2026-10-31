import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const code = ts.transpileModule(readFileSync(new URL("./userScripts.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

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
    "@bay/nncore": {
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
    "@bay/shell": {
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
    },
    "../../store/browser": { useBrowser: { getState: () => state, subscribe() {} } },
    "../../store/model": {
      isIncognitoSpace: (id) => id.startsWith("incognito:"),
      engineProfile: (id) => (["default", "shared"].includes(id) ? "" : id),
    },
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", "__DEV__", code)(
    (id) => {
      assert.ok(id in mocks, `unexpected import ${id}`);
      return mocks[id];
    },
    module,
    module.exports,
    false,
  );
  return {
    ...module.exports,
    calls,
    statuses,
    state,
    setFolder: (value) => {
      current = value;
      notice();
    },
    settled: async () => {
      for (let attempt = 0; attempt < 20; attempt++) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("loads once per native profile and reports each public space", async () => {
  const f = fixture();
  f.startUserScripts();
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
});

test("keeps a user-disabled extension disabled while reloading its source", async () => {
  const f = fixture({ existing: [{ id: "scripts", path: "/data/Scripts/extension", enabled: false, state: "DISABLED" }] });
  f.startUserScripts();
  await f.settled();
  assert.equal(f.calls.filter((x) => x[0] === "install").length, 0);
  assert.equal(f.calls.filter((x) => x[0] === "reload").length, 2);
  assert.deepEqual(f.statuses[0].profiles.Personal, { disabled: true });
});

test("removes loaded copies when the folder is invalid or uninstalled", async () => {
  for (const state of ["invalid", "absent"]) {
    const f = fixture({
      folder: { state, generation: 2, path: "/data/Scripts/extension", error: "forbidden permissions", token: "two" },
      existing: [{ id: "scripts", path: "/data/Scripts/extension", enabled: true }],
    });
    f.startUserScripts();
    await f.settled();
    assert.equal(f.calls.filter((x) => x[0] === "uninstall").length, 2);
    assert.deepEqual(f.statuses[0].profiles.Personal, state === "invalid" ? { error: "forbidden permissions" } : { removed: true });
  }
});

test("does not load scripts while CLI control is disabled", async () => {
  const f = fixture();
  f.state.settings.cliControl = false;
  f.startUserScripts();
  await f.settled();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.statuses, []);
});

test("reports spaces whose names match object prototype properties", async () => {
  const f = fixture();
  f.state.spaces.default.name = "__proto__";
  f.startUserScripts();
  await f.settled();
  assert.deepEqual(f.statuses[0].profiles.__proto__, { ok: true });
  assert.equal(Object.hasOwn(f.statuses[0].profiles, "__proto__"), true);
});
