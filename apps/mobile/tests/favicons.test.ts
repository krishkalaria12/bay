// Site icons (src/browser/favicons.ts): one download per site however many tabs open it, kept as a local file in the
// app's documents only when it is an image, deleted when the store drops the icon, and fetched in the background for
// sites Bay already shows that have none.
import assert from "node:assert/strict";
import test from "node:test";
import type { Tab } from "@bay/engine";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { Favicons, iconWidth, isImage, knownSitesWithoutIcons } from "../src/browser/favicons.ts";
import { BrowserState } from "../src/effect/ports/browserState.ts";
import { Files } from "../src/effect/ports/files.ts";
import { fakeBrowserState, fakeDiagnostics, fakeEngine, fakeFiles, withTestClock } from "../src/effect/testing.ts";
import { FAVICON_SCRIPT } from "../src/pagescripts/favicon.ts";

const ICON = "https://bay.example/apple-touch-icon.png";

/** A PNG's signature and enough bytes to be an icon. */
const PNG = "\x89PNG\r\n\x1a\n" + "x".repeat(40);

/** An ICO's header and enough bytes to be an icon. */
const ICO = "\0\0\x01\0" + "x".repeat(40);

/** A PNG this many pixels square: its signature, then the IHDR chunk that holds its width. */
const pngOf = (width: number) => {
  const bytes = (value: number) => String.fromCharCode((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);

  return "\x89PNG\r\n\x1a\n" + "\0\0\0\rIHDR" + bytes(width) + bytes(width) + "x".repeat(40);
};

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
  files.answerDownload(ICON, Effect.succeed(PNG));

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
  assert.equal(browserState.data().favicons["bay.example"], "file:///document/favicons/bay.example");
  assert.ok(files.files.has("document/favicons/bay.example"));
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

        assert.ok(files.files.has("document/favicons/bay.example"), "the icon was saved");

        yield* state.dispatch({ type: "favicon", host: "bay.example", uri: null });
        yield* Effect.yieldNow;
      }),
    ).pipe(Effect.provide(layer)),
  );

  assert.equal(browserState.data().favicons["bay.example"], undefined);
  assert.ok(!files.files.has("document/favicons/bay.example"), "the file went with it");
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

test("only an image is kept as an icon", () => {
  assert.ok(isImage(PNG));
  assert.ok(isImage(ICO));
  assert.ok(isImage("\xFF\xD8\xFF\xE0"));
  assert.ok(isImage("RIFF\0\0\0\0WEBPVP8 "));
  assert.ok(!isImage("<!doctype html>"));
  assert.ok(!isImage("<svg xmlns="));
});

test("the sites Bay shows without an icon: tabs first, then history by last visit, never a private tab", () => {
  const { browserState } = setup();

  const dispatch = (url: string, now: number) =>
    Effect.runSync(
      Effect.gen(function* () {
        const state = yield* BrowserState;

        yield* state.dispatch({ type: "visit", spaceId: "personal", url, title: url, favicon: null, now });
      }).pipe(Effect.provide(browserState.layer)),
    );

  dispatch("https://old.example/", 1);
  dispatch("https://new.example/page", 2);
  dispatch("https://www.has-icon.example/", 3);
  Effect.runSync(
    Effect.gen(function* () {
      const state = yield* BrowserState;

      yield* state.dispatch({ type: "favicon", host: "has-icon.example", uri: "file:///icon" });
    }).pipe(Effect.provide(browserState.layer)),
  );

  const data = browserState.data();
  const withPrivate = { ...data, tabs: [...data.tabs, { ...data.tabs[0]!, id: "secret", url: "https://secret.example/", private: true }] };

  assert.deepEqual(knownSitesWithoutIcons(withPrivate), ["new.example", "old.example"]);
  assert.deepEqual(knownSitesWithoutIcons(withPrivate, 1), ["new.example"]);
});

test("a known site without an icon gets its apple-touch-icon, else its favicon.ico, each asked once", async () => {
  const { downloads, files, browserState, diagnostics, layer } = setup();

  // A site that answers its apple-touch-icon with a page, and its favicon.ico with an icon.
  files.answerDownload("https://ico.example/apple-touch-icon.png", Effect.succeed("<!doctype html>" + "x".repeat(40)));
  files.answerDownload("https://ico.example/favicon.ico", Effect.succeed(ICO));
  files.answerDownload("https://bay.example/apple-touch-icon.png", Effect.succeed(PNG));

  await withTestClock(
    Effect.scoped(
      Effect.gen(function* () {
        const favicons = yield* Favicons;
        const state = yield* BrowserState;

        yield* state.dispatch({ type: "visit", spaceId: "personal", url: "https://ico.example/", title: "Ico", favicon: null, now: 1 });
        yield* state.dispatch({ type: "visit", spaceId: "personal", url: "https://bay.example/", title: "Bay", favicon: null, now: 2 });
        yield* favicons.start;
        browserState.markReady();
        yield* Effect.yieldNow;
        yield* TestClock.adjust("5 seconds");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("5 seconds");
        yield* Effect.yieldNow;
        // Another visit doesn't ask a site again this launch.
        yield* state.dispatch({ type: "visit", spaceId: "personal", url: "https://ico.example/again", title: "Ico", favicon: null, now: 3 });
        yield* TestClock.adjust("5 seconds");
      }),
    ).pipe(Effect.provide(layer)),
  );

  assert.equal(browserState.data().favicons["bay.example"], "file:///document/favicons/bay.example");
  assert.equal(browserState.data().favicons["ico.example"], "file:///document/favicons/ico.example");
  assert.equal(downloads.filter((url) => url.startsWith("https://ico.example/")).length, 2, "each path once");
  assert.equal(diagnostics.reports.length, 0);
});

test("an icon's width comes from its first bytes: a PNG's, a GIF's, an ICO's widest picture", () => {
  assert.equal(iconWidth(pngOf(180)), 180);
  assert.equal(iconWidth("GIF89a\x20\0\x20\0"), 32);
  // Two pictures, 16 and 48 px wide.
  assert.equal(iconWidth("\0\0\x01\0\x02\0" + "\x10" + "x".repeat(15) + "\x30" + "x".repeat(15)), 48);
  // A width of 0 means 256.
  assert.equal(iconWidth("\0\0\x01\0\x01\0" + "\0" + "x".repeat(15)), 256);
  assert.equal(iconWidth("\xFF\xD8\xFF\xE0"), null);
});

test("a page whose icon is too small to stay sharp gets its site's touch icon instead", async () => {
  // The page names its small icon somewhere other than the touch icon's path.
  const small = setup(JSON.stringify({ href: "https://bay.example/small.png", userAgent: "Bay" }));

  small.files.answerDownload("https://bay.example/small.png", Effect.succeed(pngOf(32)));
  small.files.answerDownload("https://bay.example/apple-touch-icon.png", Effect.succeed(pngOf(180)));

  await withTestClock(
    Effect.scoped(
      Effect.gen(function* () {
        const favicons = yield* Favicons;

        yield* favicons.fetch(fakeView(), "https://bay.example/page");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        // The site's icon is sharp now: another visit doesn't ask again.
        yield* favicons.fetch(fakeView(), "https://bay.example/other");
        yield* TestClock.adjust("1 second");
      }),
    ).pipe(Effect.provide(small.layer)),
  );

  assert.deepEqual(small.downloads, ["https://bay.example/small.png", "https://bay.example/apple-touch-icon.png"]);
  assert.equal(iconWidth(small.files.files.get("document/favicons/bay.example") ?? ""), 180);
  assert.equal(small.browserState.data().favicons["bay.example"], "file:///document/favicons/bay.example#180");
  assert.ok(!small.files.files.has("document/favicons/bay.example.part"), "nothing is left half-way");
  assert.equal(small.diagnostics.reports.length, 0);
});

test("an icon saved too small is replaced at launch when the site has a wider one, and kept when it doesn't", async () => {
  const { downloads, files, browserState, diagnostics, layer } = setup();

  files.files.set("document/favicons/bay.example", pngOf(32));
  files.files.set("document/favicons/plain.example", pngOf(16));
  files.answerDownload("https://bay.example/apple-touch-icon.png", Effect.succeed(pngOf(180)));
  files.answerDownload("https://plain.example/apple-touch-icon.png", Effect.succeed("<!doctype html>" + "x".repeat(40)));
  files.answerDownload("https://plain.example/favicon.ico", Effect.succeed("\0\0\x01\0\x01\0\x10" + "x".repeat(40)));

  await withTestClock(
    Effect.scoped(
      Effect.gen(function* () {
        const favicons = yield* Favicons;
        const state = yield* BrowserState;

        yield* state.dispatch({ type: "favicon", host: "bay.example", uri: "file:///document/favicons/bay.example" });
        yield* state.dispatch({ type: "favicon", host: "plain.example", uri: "file:///document/favicons/plain.example" });
        yield* favicons.start;
        browserState.markReady();

        for (let step = 0; step < 6; step++) {
          yield* Effect.yieldNow;
          yield* TestClock.adjust("1 second");
        }
      }),
    ).pipe(Effect.provide(layer)),
  );

  assert.equal(browserState.data().favicons["bay.example"], "file:///document/favicons/bay.example#180");
  assert.equal(iconWidth(files.files.get("document/favicons/bay.example") ?? ""), 180);
  // Neither of plain.example's is wider than its 16 px icon, which stays.
  assert.equal(browserState.data().favicons["plain.example"], "file:///document/favicons/plain.example");
  assert.equal(iconWidth(files.files.get("document/favicons/plain.example") ?? ""), 16);
  assert.equal(downloads.filter((url) => url.startsWith("https://plain.example/")).length, 2, "each path once");
  assert.equal(diagnostics.reports.length, 0);
});
