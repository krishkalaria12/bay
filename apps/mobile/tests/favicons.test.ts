// Site icons (src/browser/favicons.ts): one download per site however many tabs open it, kept as a local file, and
// deleted when the store drops the icon.
import assert from "node:assert/strict";
import test from "node:test";
import type { Tab } from "@bay/engine";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { Favicons } from "../src/browser/favicons.ts";
import { BrowserState } from "../src/effect/ports/browserState.ts";
import { Files } from "../src/effect/ports/files.ts";
import { fakeBrowserState, fakeDiagnostics, fakeEngine, fakeFiles, withTestClock } from "../src/effect/testing.ts";
import { FAVICON_SCRIPT } from "../src/pagescripts/favicon.ts";

const ICON = "https://bay.example/apple-touch-icon.png";

/** A page view that does nothing: the fake engine answers its scripts. */
const fakeView = (): Tab => ({
  load: () => Promise.resolve(),
  goBack: () => Promise.resolve(),
  goForward: () => Promise.resolve(),
  reload: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  snapshot: () => Promise.resolve(null),
  saveState: () => Promise.resolve(),
  answerPageRequest: () => Promise.resolve(),
  evaluate: () => Promise.resolve("null"),
});

/** A service over fakes, whose downloads take a second, so a test can open the site again while one runs. */
const setup = (answer = JSON.stringify({ href: ICON, userAgent: "Bay" })) => {
  const downloads: string[] = [];
  const files = fakeFiles();
  const engine = fakeEngine();
  const browserState = fakeBrowserState();
  const diagnostics = fakeDiagnostics();

  engine.answers.set(FAVICON_SCRIPT, answer);

  const slowFiles = Layer.effect(
    Files,
    Effect.gen(function* () {
      const base = yield* Files;

      return Files.of({
        ...base,
        download: (root, path, url, headers) =>
          Effect.gen(function* () {
            downloads.push(url);
            yield* Effect.sleep("1 second");
            yield* base.download(root, path, url, headers);
          }),
      });
    }),
  ).pipe(Layer.provide(files.layer));

  const layer = Favicons.layer.pipe(Layer.provideMerge(Layer.mergeAll(engine.layer, slowFiles, browserState.layer, diagnostics.layer)));

  return { downloads, files, browserState, diagnostics, layer };
};

test("a site's icon is downloaded once, however many tabs open it", async () => {
  const { downloads, files, browserState, diagnostics, layer } = setup();

  await withTestClock(
    Effect.scoped(
      Effect.gen(function* () {
        const favicons = yield* Favicons;

        yield* favicons.fetch(fakeView(), "https://bay.example/one");
        yield* favicons.fetch(fakeView(), "https://www.bay.example/two");
        yield* favicons.fetch(fakeView(), "https://bay.example/three");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;

        // The icon is saved now, so a later visit doesn't ask again.
        yield* favicons.fetch(fakeView(), "https://bay.example/four");
        yield* TestClock.adjust("1 second");
      }),
    ).pipe(Effect.provide(layer)),
  );

  assert.deepEqual(downloads, [ICON]);
  assert.equal(browserState.data().favicons["bay.example"], "file:///cache/favicons/bay.example");
  assert.ok(files.files.has("cache/favicons/bay.example"));
  assert.equal(diagnostics.reports.length, 0);
});

test("an icon the store drops takes its file with it", async () => {
  const { files, browserState, layer } = setup();

  await withTestClock(
    Effect.scoped(
      Effect.gen(function* () {
        const favicons = yield* Favicons;
        const state = yield* BrowserState;

        yield* favicons.start;
        yield* favicons.fetch(fakeView(), "https://bay.example/");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;

        assert.ok(files.files.has("cache/favicons/bay.example"), "the icon was saved");

        yield* state.dispatch({ type: "favicon", host: "bay.example", uri: null });
        yield* Effect.yieldNow;
      }),
    ).pipe(Effect.provide(layer)),
  );

  assert.equal(browserState.data().favicons["bay.example"], undefined);
  assert.ok(!files.files.has("cache/favicons/bay.example"), "the file went with it");
});

test("a page that names no usable icon saves nothing", async () => {
  const { downloads, browserState, diagnostics, layer } = setup(JSON.stringify({ href: "data:image/png;base64,AAAA", userAgent: "Bay" }));

  await withTestClock(
    Effect.scoped(
      Effect.gen(function* () {
        const favicons = yield* Favicons;

        yield* favicons.fetch(fakeView(), "https://bay.example/");
        yield* Effect.yieldNow;
      }),
    ).pipe(Effect.provide(layer)),
  );

  assert.deepEqual(downloads, []);
  assert.deepEqual(browserState.data().favicons, {});
  assert.equal(diagnostics.reports.length, 0, "a site without an icon is not a failure");
});
