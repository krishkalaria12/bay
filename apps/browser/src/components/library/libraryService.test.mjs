import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const { LibraryEngine, LibraryService, useLibrary } = await import("./libraryService.ts");

test("disposing the library service releases its document subscription", async () => {
  const writes = [];

  const engine = Layer.succeed(LibraryEngine)({
    read: () => ({ version: 1, easels: {}, media: {}, removedMediaPaths: [] }),
    write: (data) => writes.push(data),
    retain: () => Effect.succeed(null),
  });

  const runtime = ManagedRuntime.make(LibraryService.layer.pipe(Layer.provide(engine)));

  useLibrary.setState({ loaded: true, error: null, easels: {}, media: {}, removedMediaPaths: [] });

  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const library = yield* LibraryService;

        yield* library.start;
        yield* library.start;
      }),
    );
    useLibrary.setState({ removedMediaPaths: ["first.png"] });
    assert.equal(writes.length, 1, "repeated start registers one writer");
  } finally {
    await runtime.dispose();
  }

  useLibrary.setState({ removedMediaPaths: ["first.png", "second.png"] });
  assert.equal(writes.length, 1, "a disposed service cannot write later changes");
});
