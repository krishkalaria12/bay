// The settings' multi-step work (components/settings/workflows.ts): Touch ID, the CSV import and export, clearing
// data and recording a shortcut, against a fake engine and Mac.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const { fakeDiagnostics } = await import("../../effect/testing.ts");
const { SettingsEngine, SettingsFailure, SettingsWorkflows, usePasswordUnlocks } = await import("./workflows.ts");

const failure = (name, message) => new SettingsFailure({ operation: { name }, cause: new Error(message) });

const withWorkflows = async (use) => {
  const lab = {
    unlocks: 0,
    unlockAnswer: true,
    saved: [],
    saveFails: null,
    csv: [],
    chosen: "/tmp/passwords.csv",
    exportGate: null,
    exports: 0,
    cleared: [],
    clearFails: false,
    appHistory: [],
    recordings: 0,
    recordGates: [],
    stops: 0,
  };

  const diagnostics = fakeDiagnostics();

  const engine = Layer.succeed(SettingsEngine)({
    unlockPasswords: () => Effect.sync(() => (lab.unlocks++, lab.unlockAnswer)),
    listPasswords: () => Effect.succeed([{ origin: "https://a.example", username: "me" }]),
    neverSaveOrigins: () => Effect.succeed(["https://never.example"]),
    savePassword: (profile, origin, username, password) =>
      lab.saveFails === origin
        ? Effect.fail(failure("passwords.save", "The Keychain is locked"))
        : Effect.sync(() => (lab.saved.push([origin, username, password]), true)),
    chooseCsv: () => Effect.succeed(lab.chosen),
    readCsv: () => Effect.succeed(lab.csv),
    exportPasswords: () =>
      Effect.promise(async () => {
        lab.exports++;

        if (lab.exportGate) await lab.exportGate.promise;

        return { status: "succeeded", path: "/Users/me/Documents/Passwords.csv" };
      }),
    clearEngineData: (profile, types, since) =>
      lab.clearFails ? Effect.fail(failure("data.clear", "engine refused")) : Effect.sync(() => void lab.cleared.push({ profile, types, since })),
    clearAppHistory: (spaceId, since) => Effect.sync(() => void lab.appHistory.push({ spaceId, since })),
    recordShortcut: () =>
      Effect.promise(async () => {
        lab.recordings++;

        const gate = lab.recordGates.shift();

        return gate ? await gate.promise : { key: "k", modifiers: ["command"], keyCode: 40 };
      }),
    stopRecording: () => Effect.sync(() => void lab.stops++),
  });

  const runtime = ManagedRuntime.make(SettingsWorkflows.layer.pipe(Layer.provide(Layer.mergeAll(engine, diagnostics.layer))));

  usePasswordUnlocks.setState({}, true);

  const workflows = (program) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* SettingsWorkflows;

        return yield* program(service);
      }),
    );

  try {
    await use({ lab, workflows, diagnostics });
  } finally {
    await runtime.dispose();
  }

  return lab;
};

test("the passwords stay locked until Touch ID is given, and a refusal is not asked again", async () => {
  await withWorkflows(async ({ lab, workflows }) => {
    assert.equal(await workflows((w) => w.passwords("p")), null, "locked: nothing to show");

    lab.unlockAnswer = false;
    assert.equal(await workflows((w) => w.unlock("p")), false);
    assert.equal(lab.unlocks, 1, "asked once");
    assert.equal(await workflows((w) => w.passwords("p")), null);

    lab.unlockAnswer = true;
    assert.equal(await workflows((w) => w.unlock("p")), true);
    assert.deepEqual((await workflows((w) => w.passwords("p"))).never, ["https://never.example"]);

    // Already unlocked: Touch ID is not asked again.
    await workflows((w) => w.unlock("p"));
    assert.equal(lab.unlocks, 2);
    assert.equal(await workflows((w) => w.passwords("other")), null, "another profile has its own lock");
  });
});

test("an import saves the passwords one at a time, and a write that failed ends it", async () => {
  await withWorkflows(async ({ lab, workflows }) => {
    lab.csv = [
      { url: "https://a.example/login", username: "a", password: "1" },
      { url: "https://b.example/", username: "b", password: "" },
      { url: "https://c.example/x", username: "c", password: "3" },
    ];

    assert.deepEqual(await workflows((w) => w.importCsv("p")), { kind: "imported", saved: 2 });
    assert.deepEqual(
      lab.saved.map(([origin]) => origin),
      ["https://a.example", "https://c.example"],
    );

    lab.saved.length = 0;
    lab.saveFails = "https://a.example";

    const failed = await workflows((w) => w.importCsv("p"));

    assert.equal(failed.kind, "failed");
    assert.match(failed.reason, /Keychain/);
    assert.equal(lab.saved.length, 0, "nothing after the failed write, and nothing written twice");

    lab.chosen = null;
    assert.deepEqual(await workflows((w) => w.importCsv("p")), { kind: "cancelled" });

    lab.chosen = undefined;
    assert.deepEqual(await workflows((w) => w.importCsv("p")), { kind: "unavailable" });
  });
});

test("one export runs at a time for a profile", async () => {
  await withWorkflows(async ({ lab, workflows }) => {
    lab.exportGate = Promise.withResolvers();

    const first = workflows((w) => w.exportCsv("p"));

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await workflows((w) => w.exportCsv("p")), { status: "inProgress" });

    lab.exportGate.resolve();
    assert.equal((await first).status, "succeeded");
    assert.equal(lab.exports, 1);
    assert.equal((await workflows((w) => w.exportCsv("p"))).status, "succeeded", "the next one runs once the first is done");
  });
});

test("a clear says what it cleared, and the engine's failure stays visible", async () => {
  await withWorkflows(async ({ lab, workflows, diagnostics }) => {
    assert.deepEqual(await workflows((w) => w.clearData("default", { since: 5, history: true, siteData: true })), { history: true, engine: "cleared" });
    assert.deepEqual(lab.cleared[0].types, ["history", "siteData", "cache"]);

    lab.clearFails = true;
    assert.deepEqual(await workflows((w) => w.clearData("default", { history: true, siteData: false })), { history: true, engine: "failed" });
    assert.equal(lab.appHistory.length, 2, "the app's history was cleared both times");
    assert.equal(lab.cleared.length, 1, "the failed clear is not tried again");
    assert.ok(
      diagnostics.reports.every((r) => !/engine refused/.test(r.message)),
      "the engine's words are not reported",
    );

    assert.deepEqual(await workflows((w) => w.clearData("incognito:w1", { history: true, siteData: true })), { history: true, engine: "none" });
  });
});

test("a recording always stops: a new one, its own pane closing, or the scope", async () => {
  const lab = await withWorkflows(async ({ lab, workflows }) => {
    const firstGate = Promise.withResolvers();

    lab.recordGates.push(firstGate);

    const first = workflows((w) => w.record("shortcuts"));

    await new Promise((resolve) => setImmediate(resolve));

    // Another pane starts recording: the first stops, and its late answer is nobody's.
    const second = workflows((w) => w.record("littleBay"));

    firstGate.resolve({ key: "x", modifiers: ["command"], keyCode: 7 });
    assert.equal(await first, null);
    assert.equal((await second).key, "k");
    assert.equal(lab.stops, 1);

    // A pane that closes stops only its own recording.
    await workflows((w) => w.stopRecording("shortcuts"));
    assert.equal(lab.stops, 1);

    lab.recordGates.push(Promise.withResolvers());
    void workflows((w) => w.record("shortcuts")).catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    await workflows((w) => w.stopRecording("shortcuts"));
    assert.equal(lab.stops, 2);

    lab.recordGates.push(Promise.withResolvers());
    // The runtime closes under this one: its promise ends as a cancellation.
    void workflows((w) => w.record("littleBay")).catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.equal(lab.stops, 3, "the scope's close stopped the recording that was running");
});
