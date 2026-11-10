// The profile cleanup (lib/profileCleanup.ts): what it deletes, what it keeps queued, and what it tries again.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const { useBrowser } = await import("../store/browserStore.ts");
const { fakeDiagnostics } = await import("../effect/testing.ts");
const { ProfileCleanup, ProfileEngine } = await import("./profileCleanup.ts");

const S = () => useBrowser.getState();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Chrome's profiles, as a test wants them: what was deleted, and what Chrome kept.
const fakeEngine = () => {
  const fake = {
    deleted: [],
    // What Chrome could not delete, by profile.
    left: new Map(),
  };

  const layer = Layer.succeed(ProfileEngine)({
    delete: (engine) =>
      Effect.sync(() => {
        fake.deleted.push(engine);

        return fake.left.get(engine) ?? [];
      }),
  });

  return { layer, fake };
};

const setup = () => {
  const engine = fakeEngine();
  const diagnostics = fakeDiagnostics();
  const layer = ProfileCleanup.layer.pipe(Layer.provide(Layer.mergeAll(engine.layer, diagnostics.layer)));
  const runtime = ManagedRuntime.make(layer);

  return { engine: engine.fake, diagnostics, runtime };
};

const start = (runtime) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const cleanup = yield* ProfileCleanup;

      yield* cleanup.start;
    }),
  );

test("a deleted profile's data goes once its views have closed", async () => {
  const { engine, runtime } = setup();

  S().hydrate({});
  S().createSpace({ name: "Work" });
  S().deleteSpace("default");

  await start(runtime);
  await wait(1_700);

  assert.deepEqual(engine.deleted, [""]);
  assert.deepEqual(S().orphanedProfileData, [], "the queue is empty once the data is gone");

  await runtime.dispose();
});

test("what Chrome could not delete stays queued, and the next launch tries again", async () => {
  const { engine, runtime } = setup();

  S().hydrate({});
  S().createSpace({ name: "Work" });
  S().deleteSpace("default");
  engine.left.set("", ["passwords"]);

  await start(runtime);
  await wait(1_700);

  assert.deepEqual(engine.deleted, [""]);
  assert.deepEqual(S().orphanedProfileData, [""], "a failed deletion stays queued");

  // The next launch tries again, and this time it succeeds.
  engine.left.clear();
  await start(runtime);
  await wait(1_700);

  assert.deepEqual(engine.deleted, ["", ""]);
  assert.deepEqual(S().orphanedProfileData, []);

  await runtime.dispose();
});
