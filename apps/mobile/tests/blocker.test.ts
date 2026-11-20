// The content blocker (src/privacy/blocker.ts): it follows the blockContent preference, refreshes stale filter lists
// each on its own, applies them to the engines one call at a time, and leaves nothing behind when it is turned off.
import assert from "node:assert/strict";
import test from "node:test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { BrowserState } from "../src/effect/ports/browserState.ts";
import { Engine } from "../src/effect/ports/engine.ts";
import { FileError } from "../src/effect/ports/files.ts";
import { Http, type HttpResponse } from "../src/effect/ports/http.ts";
import { fakeBrowserState, fakeDiagnostics, fakeEngine, fakeFiles, fakeHttp, ResourceLedger, testClockLayer } from "../src/effect/testing.ts";
import { Blocker, HEAD_TIMEOUT, listPath, META_PATH } from "../src/privacy/blocker.ts";
import { useBlockerStatus } from "../src/privacy/contentBlocking.ts";
import { FILTER_LISTS, REFRESH_AFTER, type FilterListId } from "../src/privacy/filterLists.ts";

const NOW = 100 * REFRESH_AFTER;
const HOUR = 60 * 60 * 1000;
const STALE = NOW - 2 * REFRESH_AFTER;

/** What lists.json keeps about a list. */
type SavedList = { fetchedAt: number; etag?: string };

/** Plausible list text: long enough to be a list, and a different length for each version (the fake digests by length). */
const listText = (version: number): string => `! Title: test\n${"||ads.example^\n".repeat(100 + version)}`;

const at = (path: string) => `document/${path}`;

/** A HEAD answer with the validators a server sends. */
const head = (validators: Record<string, string>): HttpResponse => ({
  status: 200,
  ok: true,
  body: "",
  headers: { get: (name) => validators[name] ?? null },
});

/** Lets the blocker's fibers run until they wait on something the test controls. */
const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 20; turn++) yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
});

const setup = (engineLayer?: (base: Layer.Layer<Engine>) => Layer.Layer<Engine>, httpLayer?: (base: Layer.Layer<Http>) => Layer.Layer<Http>) => {
  const ledger = new ResourceLedger();
  const files = fakeFiles();
  const http = fakeHttp();
  const engine = fakeEngine(ledger);
  const state = fakeBrowserState(ledger);
  const diagnostics = fakeDiagnostics();
  const downloads: string[] = [];

  const ports = Layer.mergeAll(
    files.layer,
    httpLayer ? httpLayer(http.layer) : http.layer,
    engineLayer ? engineLayer(engine.layer) : engine.layer,
    state.layer,
    diagnostics.layer,
  );

  const layer = Blocker.layer.pipe(Layer.provideMerge(ports));

  /** Answers a list's download with `contents`, and notes that it was asked for. */
  const answer = (url: string, contents: Effect.Effect<string, FileError>) =>
    files.answerDownload(
      url,
      Effect.suspend(() => {
        downloads.push(url);

        return contents;
      }),
    );

  /** Saves every list as if a refresh at `fetchedAt` had downloaded it, with what `saved` says about some of them. */
  const cacheAll = (fetchedAt: number, saved: Partial<Record<FilterListId, SavedList>> = {}) => {
    const meta: Partial<Record<FilterListId, SavedList>> = {};

    for (const list of FILTER_LISTS) {
      files.files.set(at(listPath(list.id)), listText(0));
      meta[list.id] = saved[list.id] ?? { fetchedAt };
    }

    files.files.set(at(META_PATH), JSON.stringify(meta));
  };

  // SAFETY: the blocker writes lists.json as JSON metadata keyed by list id.
  const meta = (): Partial<Record<FilterListId, SavedList>> => JSON.parse(files.files.get(at(META_PATH)) ?? "{}");
  const temporaryFiles = () => [...files.files.keys()].filter((path) => path.endsWith(".download"));

  /** Starts the blocker on a scope that closes when `body` is done, with the saved state read. */
  const run = (body: Effect.Effect<void, never, BrowserState | Blocker>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);

        const blocker = yield* Blocker;

        yield* blocker.start;
        state.markReady();
        yield* settle;
        yield* body;
      }).pipe(Effect.scoped, Effect.provide(layer), Effect.provide(testClockLayer)),
    );

  useBlockerStatus.setState({ status: { state: "loading" } });

  return { layer, ledger, files, http, engine, state, diagnostics, downloads, answer, cacheAll, meta, temporaryFiles, run };
};

const setBlocking = (enabled: boolean) =>
  Effect.gen(function* () {
    const state = yield* BrowserState;

    yield* state.dispatch({ type: "block-content", enabled });
    yield* settle;
  });

const [first, second, third] = FILTER_LISTS;

test("fresh lists are left alone, unchanged ones are only checked, and a changed one is downloaded and applied", async () => {
  const blocker = setup();

  blocker.cacheAll(NOW - HOUR, { [second.id]: { fetchedAt: STALE, etag: '"b1"' }, [third.id]: { fetchedAt: STALE, etag: '"c1"' } });
  blocker.http.answer(second.url, head({ etag: '"b1"' }));
  blocker.http.answer(third.url, head({ etag: '"c2"' }));
  blocker.answer(third.url, Effect.succeed(listText(1)));

  await blocker.run(Effect.void);

  assert.deepEqual(
    blocker.http.requests.map((request) => request.url),
    [second.url, third.url],
    "only the stale lists are checked",
  );
  assert.ok(!blocker.http.requests.some((request) => request.url === first.url), "a fresh list isn't checked");
  assert.deepEqual(blocker.downloads, [third.url], "only the list the server changed is downloaded");
  assert.equal(blocker.files.files.get(at(listPath(third.id))), listText(1));

  const meta = blocker.meta();

  assert.deepEqual(meta[second.id], { fetchedAt: NOW, etag: '"b1"' }, "an unchanged list counts as fetched now");
  assert.deepEqual(meta[third.id], { fetchedAt: NOW, etag: '"c2"' });
  assert.equal(meta[first.id]?.fetchedAt, NOW - HOUR);

  assert.equal(blocker.engine.blocking.length, 2, "the cache is applied, then the refreshed lists");
  assert.equal(blocker.engine.blocking[0]?.files?.length, 8);
  assert.notEqual(blocker.engine.blocking[0]?.version, blocker.engine.blocking[1]?.version);
  assert.deepEqual(useBlockerStatus.getState().status, { state: "ready", lists: 8 });
  assert.deepEqual(blocker.temporaryFiles(), []);
});

test("a stale list that comes down the same is not applied again", async () => {
  const blocker = setup();

  blocker.cacheAll(NOW - HOUR, { [first.id]: { fetchedAt: STALE } });
  // No validators from the server: the list is downloaded and compared with the saved copy.
  blocker.answer(first.url, Effect.succeed(listText(0)));

  await blocker.run(Effect.void);

  assert.deepEqual(blocker.downloads, [first.url]);
  assert.equal(blocker.engine.blocking.length, 1, "nothing changed, so the cache stays applied");
  assert.equal(blocker.meta()[first.id]?.fetchedAt, NOW);
  assert.deepEqual(blocker.temporaryFiles(), []);
});

test("a list that fails keeps its saved copy, and the other seven are refreshed", async () => {
  const blocker = setup();
  const failing = FILTER_LISTS[4];

  assert.equal(failing.id, "easylist");

  blocker.cacheAll(STALE);

  for (const list of FILTER_LISTS) {
    blocker.answer(
      list.url,
      list === failing
        ? Effect.fail(new FileError({ operation: { name: "files.download", resource: list.url }, cause: new Error("offline") }))
        : Effect.succeed(listText(1)),
    );
  }

  await blocker.run(Effect.void);

  assert.equal(blocker.files.files.get(at(listPath(failing.id))), listText(0), "the failed list keeps its saved copy");

  for (const list of FILTER_LISTS.filter((entry) => entry !== failing)) assert.equal(blocker.files.files.get(at(listPath(list.id))), listText(1));

  const meta = blocker.meta();

  assert.equal(meta[failing.id]?.fetchedAt, STALE, "the failed list is tried again next time");
  assert.equal(FILTER_LISTS.filter((list) => meta[list.id]?.fetchedAt === NOW).length, 7);
  assert.equal(blocker.engine.blocking.at(-1)?.files?.length, 8, "all eight lists are applied");
  assert.deepEqual(useBlockerStatus.getState().status, { state: "ready", lists: 8 });
  assert.equal(blocker.diagnostics.warnings.length, 1, "the failure is noted once");
  assert.match(blocker.diagnostics.warnings[0] ?? "", /EasyList/);
  assert.deepEqual(blocker.diagnostics.reports, [], "a list that fails to download is not a crash");
  assert.deepEqual(blocker.temporaryFiles(), []);
});

test("turning blocking off mid-refresh leaves no temporary file and no late apply", async () => {
  const blocker = setup();
  const gate = Deferred.makeUnsafe<void>();

  // A first run: nothing is cached, and every download waits for the gate.
  for (const list of FILTER_LISTS) blocker.answer(list.url, Effect.as(Deferred.await(gate), listText(1)));

  await blocker.run(
    Effect.gen(function* () {
      assert.ok(blocker.temporaryFiles().length > 0, "the refresh is downloading");
      assert.deepEqual(blocker.engine.blocking, [], "there is nothing to apply yet");
      assert.deepEqual(useBlockerStatus.getState().status, { state: "loading" });

      yield* setBlocking(false);

      assert.deepEqual(blocker.temporaryFiles(), [], "the interrupted downloads left nothing behind");
      assert.deepEqual(blocker.engine.blocking, [{ files: null, version: "" }]);
      assert.deepEqual(useBlockerStatus.getState().status, { state: "off" });

      // The downloads would have finished now, but nobody is waiting for them.
      yield* Deferred.succeed(gate, undefined);
      yield* settle;

      assert.deepEqual(blocker.engine.blocking, [{ files: null, version: "" }], "no list was applied after blocking was turned off");
      assert.ok(!FILTER_LISTS.some((list) => blocker.files.files.has(at(listPath(list.id)))), "no list was put in place");
      assert.deepEqual(useBlockerStatus.getState().status, { state: "off" });
    }),
  );

  assert.equal(blocker.ledger.count(), 0, "closing the scope let go of the store subscription");
  assert.deepEqual(blocker.diagnostics.reports, []);
});

test("applies reach the engines one at a time, in the order they were asked for", async () => {
  const gate = Deferred.makeUnsafe<void>();
  const calls: string[] = [];
  let running = 0;
  let most = 0;

  // An engine that takes its time with a list until the gate opens.
  const slowEngine = (base: Layer.Layer<Engine>) =>
    Layer.effect(
      Engine,
      Effect.gen(function* () {
        const engine = yield* Engine;

        return Engine.of({
          ...engine,
          setContentBlocking: (files, version) =>
            Effect.gen(function* () {
              running += 1;
              most = Math.max(most, running);
              calls.push(files ? "lists" : "off");

              if (files) yield* Deferred.await(gate);

              yield* engine.setContentBlocking(files, version);
              running -= 1;
            }),
        });
      }),
    ).pipe(Layer.provide(base));

  const blocker = setup(slowEngine);

  blocker.cacheAll(NOW - HOUR);

  await blocker.run(
    Effect.gen(function* () {
      assert.deepEqual(calls, ["lists"], "the cache is being applied");

      yield* setBlocking(false);

      assert.deepEqual(calls, ["lists"], "turning blocking off waits for the apply in progress");

      yield* Deferred.succeed(gate, undefined);
      yield* settle;

      assert.deepEqual(calls, ["lists", "off"]);
      assert.deepEqual(
        blocker.engine.blocking.map((call) => (call.files ? "lists" : "off")),
        ["lists", "off"],
      );
      assert.equal(most, 1, "no two applies overlapped");
      assert.deepEqual(useBlockerStatus.getState().status, { state: "off" });

      yield* setBlocking(true);

      assert.deepEqual(calls, ["lists", "off", "lists"]);
      assert.deepEqual(useBlockerStatus.getState().status, { state: "ready", lists: 8 });
    }),
  );
});

test("a server that doesn't answer the HEAD request within ten seconds is downloaded from", async () => {
  const silentHead = (base: Layer.Layer<Http>) =>
    Layer.effect(
      Http,
      Effect.gen(function* () {
        const http = yield* Http;

        return Http.of({ ...http, send: (request) => (request.method === "HEAD" ? Effect.never : http.send(request)) });
      }),
    ).pipe(Layer.provide(base));

  const blocker = setup(undefined, silentHead);

  blocker.cacheAll(NOW - HOUR, { [first.id]: { fetchedAt: STALE, etag: '"a1"' } });
  blocker.answer(first.url, Effect.succeed(listText(1)));

  await blocker.run(
    Effect.gen(function* () {
      assert.deepEqual(blocker.downloads, [], "the HEAD request is still waiting");

      yield* TestClock.adjust(HEAD_TIMEOUT);
      yield* settle;

      assert.deepEqual(blocker.downloads, [first.url]);
      assert.equal(blocker.engine.blocking.length, 2);
      assert.deepEqual(blocker.meta()[first.id], { fetchedAt: NOW }, "the new copy has no validators to keep");
    }),
  );
});

test("the blocker waits for the saved preferences and pauses where they say", async () => {
  const blocker = setup();

  blocker.cacheAll(NOW - HOUR);

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);

      const service = yield* Blocker;
      const state = yield* BrowserState;

      yield* service.start;
      yield* settle;

      assert.deepEqual(blocker.engine.blocking, [], "nothing is applied before the saved state is read");

      yield* state.dispatch({ type: "block-content", enabled: false });
      blocker.state.markReady();
      yield* settle;

      assert.deepEqual(blocker.engine.blocking, [{ files: null, version: "" }], "the saved preference decides");

      yield* state.dispatch({ type: "pause-blocking", host: "www.example.com", paused: true });
      yield* settle;

      assert.deepEqual(blocker.engine.pausedHosts.at(-1), ["example.com"]);
    }).pipe(Effect.scoped, Effect.provide(blocker.layer), Effect.provide(testClockLayer)),
  );
});
