// The app's ties to the Mac (lib/appIntegrationService.ts): Handoff and AppleScript, against a fake Mac and the
// test clock.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as TestClock from "effect/testing/TestClock";

const { useBrowser } = await import("../store/browserStore.ts");
const { fakeDiagnostics } = await import("../effect/testing.ts");
const { AppIntegrationService, IntegrationEngine } = await import("./appIntegrationService.ts");

const S = () => useBrowser.getState();

const withIntegration = async (use) => {
  const lab = { activities: [], states: [], replies: [], scriptListeners: [], commandListeners: [], responseListeners: [] };

  const listen = (list) => (listener) =>
    Effect.sync(() => {
      lab[list].push(listener);

      return () => (lab[list] = lab[list].filter((l) => l !== listener));
    });

  const engine = Layer.succeed(IntegrationEngine)({
    onCommand: listen("commandListeners"),
    onNotificationResponse: listen("responseListeners"),
    onScriptCommand: listen("scriptListeners"),
    setWindowActivity: (windowId, url, title) => Effect.sync(() => void lab.activities.push({ windowId, url, title })),
    setScriptState: (state) => Effect.sync(() => void lab.states.push(state)),
    replyToScript: (id, result, error) => Effect.sync(() => void lab.replies.push({ id, result, error })),
  });

  const runtime = ManagedRuntime.make(
    Layer.mergeAll(AppIntegrationService.layer.pipe(Layer.provide(Layer.mergeAll(engine, fakeDiagnostics().layer))), TestClock.layer()),
  );

  S().hydrate({});

  const service = (program) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const integration = yield* AppIntegrationService;

        return yield* program(integration);
      }),
    );

  const handlers = {
    command: () => {},
    notificationResponse: () => {},
    runScript: async (command) => {
      if (command.command === "fail") throw new Error("That tab no longer exists.");

      if (command.command === "slow") await new Promise(() => {});

      return { done: true };
    },
    scriptState: (s) => ({ windows: s.windowOrder.map((id) => ({ id })), profiles: [] }),
  };

  const advance = (ms) => runtime.runPromise(TestClock.adjust(ms));

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  try {
    await use({ lab, service, handlers, advance, settle });
  } finally {
    await runtime.dispose();
  }

  return lab;
};

test("Handoff hears a burst of changes once, and never a private window's page", async () => {
  await withIntegration(async ({ lab, service, handlers, advance }) => {
    const main = S().windowOrder[0] ?? S().createWindow();

    await service((integration) => integration.start(handlers));
    await advance(1_000);

    const told = lab.activities.length;

    const tabId = S().windows[main].activeTabIds[S().windows[main].spaceId];

    S().updateTab(tabId, { url: "https://example.com/one", title: "One" });
    S().updateTab(tabId, { url: "https://example.com/two", title: "Two" });
    await advance(250);

    const after = lab.activities.slice(told);

    assert.equal(after.length, 1, "a burst is one update");
    assert.deepEqual(after[0], { windowId: main, url: "https://example.com/two", title: "Two" });

    const incognito = S().createWindow({ incognito: true, url: "https://secret.example/" });

    await advance(250);
    assert.ok(
      lab.activities.filter((a) => a.windowId === incognito).every((a) => a.url === null),
      "a private window shows Handoff nothing",
    );
  });
});

test("a script's command is answered once, after the state it changed", async () => {
  await withIntegration(async ({ lab, service, handlers, settle }) => {
    await service((integration) => integration.start(handlers));
    await settle();

    lab.scriptListeners[0]({ id: "1", command: "newTab" });
    lab.scriptListeners[0]({ id: "2", command: "fail" });
    await settle();
    await settle();

    assert.deepEqual(
      lab.replies.map((r) => [r.id, r.error]),
      [
        ["1", null],
        ["2", "That tab no longer exists."],
      ],
    );
    assert.deepEqual(lab.replies[0].result, { done: true });
  });
});

test("a command still running when the app's scope closes is told so, once", async () => {
  let pending = -1;

  const lab = await withIntegration(async ({ lab, service, handlers, settle }) => {
    await service((integration) => integration.start(handlers));
    lab.scriptListeners[0]({ id: "slow", command: "slow" });
    await settle();

    pending = await service((integration) => Effect.sync(() => integration.pendingScripts()));
    assert.equal(lab.replies.length, 0);
  });

  assert.equal(pending, 1);
  assert.deepEqual(
    lab.replies.map((r) => r.id),
    ["slow"],
  );
  assert.match(lab.replies[0].error, /stopped/);
  assert.equal(lab.scriptListeners.length, 0, "the listener is given back");
});
