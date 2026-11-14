// The saved language (src/i18n/service.ts): a launch read shows the saved language, a pick in Settings wins over a read
// that finishes after it, and quick picks land on disk in the order they were made.
import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { Files } from "../src/effect/ports/files.ts";
import { fakeDiagnostics, fakeFiles, fakeLifecycle, withTestClock } from "../src/effect/testing.ts";
import { localeDocument } from "../src/i18n/document.ts";
import { currentLocale, savedLocale, setLocale } from "../src/i18n/index.ts";
import { LOCALE_FILE, LocaleService } from "../src/i18n/service.ts";

const SAVED = `document/${LOCALE_FILE}`;

/** How long the fake disk takes to read or write a file. */
const DISK_DELAY = 50;

/** The fakes a locale test runs against, with a slow disk that remembers the order of its writes. */
const harness = () => {
  const diagnostics = fakeDiagnostics();
  const files = fakeFiles();
  const lifecycle = fakeLifecycle();
  const writes: string[] = [];

  const slowFiles = Layer.effect(
    Files,
    Effect.gen(function* () {
      const inner = yield* Files;

      return Files.of({
        ...inner,
        read: (root, path) => Effect.andThen(Effect.sleep(DISK_DELAY), inner.read(root, path)),
        write: (root, path, contents) =>
          Effect.andThen(
            Effect.sleep(DISK_DELAY),
            Effect.andThen(
              Effect.sync(() => void writes.push(contents)),
              inner.write(root, path, contents),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide(files.layer));

  const layer = LocaleService.layer.pipe(Layer.provide(Layer.mergeAll(slowFiles, diagnostics.layer, lifecycle.layer)));

  /** Runs a test program with the locale service started, under the test clock. */
  const run = <A>(program: Effect.Effect<A, never, TestClock.TestClock>) =>
    withTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const locale = yield* LocaleService;

          yield* locale.start();

          return yield* program;
        }),
      ).pipe(Effect.provide(layer)),
    );

  return { diagnostics, files, lifecycle, writes, run };
};

test("the saved language is shown at launch", async () => {
  const { files, run } = harness();

  files.files.set(SAVED, localeDocument("es"));

  await run(TestClock.adjust(DISK_DELAY));

  assert.equal(currentLocale(), "es");
  assert.equal(savedLocale(), "es");
});

test("a pick in Settings wins over a launch read that finishes later", async () => {
  const { files, lifecycle, run } = harness();

  files.files.set(SAVED, localeDocument("de"));

  await run(
    Effect.gen(function* () {
      // The read is still on its way when the user picks.
      setLocale("fr");
      assert.equal(currentLocale(), "fr", "the pick shows at once");

      yield* TestClock.adjust(DISK_DELAY * 4);
    }),
  );

  assert.equal(currentLocale(), "fr", "the late read did not undo the pick");
  assert.equal(savedLocale(), "fr");
  assert.equal(files.files.get(SAVED), localeDocument("fr"));
  assert.equal(lifecycle.handlers.length, 0, "closing the scope took the handler away");
});

test("quick picks write in order, and the last one is on disk", async () => {
  const { files, writes, run } = harness();

  await run(
    Effect.gen(function* () {
      yield* TestClock.adjust(DISK_DELAY);

      setLocale("fr");
      setLocale("de");
      setLocale("ja");

      yield* TestClock.adjust(DISK_DELAY * 10);
    }),
  );

  assert.deepEqual(writes, [localeDocument("fr"), localeDocument("de"), localeDocument("ja")]);
  assert.equal(files.files.get(SAVED), localeDocument("ja"));
  assert.equal(files.files.has(`${SAVED}.tmp`), false, "the temporary file was moved over the saved one");
});

test("following the device again forgets the saved language", async () => {
  const { files, run } = harness();

  files.files.set(SAVED, localeDocument("fr"));

  await run(
    Effect.gen(function* () {
      yield* TestClock.adjust(DISK_DELAY);
      assert.equal(savedLocale(), "fr");

      setLocale(null);
      yield* TestClock.adjust(DISK_DELAY);
    }),
  );

  assert.equal(savedLocale(), null);
  assert.equal(files.files.has(SAVED), false);
});
