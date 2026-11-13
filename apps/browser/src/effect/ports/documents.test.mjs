// The documents port (effect/ports/documents.ts): what the app keeps on disk, and the saves it is still waiting for.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const { Documents } = await import("./documents.ts");
const { docs, heldSaves } = await import("../../test-native-stub.mjs");

const runtime = ManagedRuntime.make(Documents.layer);

const withDocuments = (use) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const documents = yield* Documents;

      return yield* use(documents);
    }),
  );

test("a document that was never written reads as nothing", async () => {
  const text = await withDocuments((documents) => documents.read("nothing-here.json"));

  assert.equal(text, null);
});

test("a written document reads back what was written", async () => {
  await withDocuments((documents) => documents.write("greeting.json", "hello"));

  assert.equal(docs.get("greeting.json"), "hello");
  assert.equal(await withDocuments((documents) => documents.read("greeting.json")), "hello");
});

test("a save that cannot land is a typed failure", async () => {
  heldSaves.error = new Error("disk full");

  try {
    const exit = await runtime.runPromiseExit(
      Effect.gen(function* () {
        const documents = yield* Documents;

        return yield* documents.save("broken.json", "{}");
      }),
    );

    assert.equal(exit._tag, "Failure");
  } finally {
    heldSaves.error = null;
  }
});

test("settled waits for a save that has not landed yet", async () => {
  heldSaves.on = true;
  heldSaves.queue = [];

  try {
    let settled = false;

    const waiting = runtime.runPromise(
      Effect.gen(function* () {
        const documents = yield* Documents;

        yield* documents.save("slow.json", "{}");
      }),
    );

    const done = runtime
      .runPromise(
        Effect.gen(function* () {
          const documents = yield* Documents;

          yield* documents.settled;
          settled = true;
        }),
      )
      .then(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(settled, false);

    for (const land of heldSaves.queue.splice(0)) land();

    await Promise.all([waiting, done]);
    assert.equal(settled, true);
    assert.equal(docs.get("slow.json"), "{}");
  } finally {
    heldSaves.on = false;
  }
});

test("a layer of documents can be provided to a service that needs them", async () => {
  const scoped = ManagedRuntime.make(Layer.mergeAll(Documents.layer));

  const text = await scoped.runPromise(
    Effect.gen(function* () {
      const documents = yield* Documents;

      return yield* documents.read("greeting.json");
    }),
  );

  assert.equal(text, "hello");
  await scoped.dispose();
});
