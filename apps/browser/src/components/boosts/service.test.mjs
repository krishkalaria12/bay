// The Boosts' own work (components/boosts/service.ts): the count a page gives, and the document the Boosts are kept
// in. The rules that make a Boost stay plain (lib/boosts.ts): the same for every build.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const { fakeDiagnostics } = await import("../../effect/testing.ts");
const { DocumentError, Documents } = await import("../../effect/ports/documents.ts");
const { boostDocumentJson, engineBoosts, newBoost } = await import("../../lib/boosts.ts");
const { BoostEngine, BoostsService } = await import("./service.ts");
const { applySyncedBoosts, useBoosts } = await import("./state.ts");

const TAB = "tab-1";
const BOOST = newBoost("b1", "example.com", 0, "My Boost");

// The page the editor asks: it holds the query until the test lets it answer.
const fakeEngine = () => {
  const lab = { asked: [] };
  let askedNow = null;

  const layer = Layer.succeed(BoostEngine)({
    counts: (tabId, selectors) =>
      Effect.promise(async () => {
        const gate = Promise.withResolvers();
        const asked = { tabId, selectors, gate };

        lab.asked.push(asked);
        askedNow?.resolve(asked);

        const answer = await gate.promise;

        return answer ?? selectors.map(() => 3);
      }),
  });

  // The next query the page is asked, once it has been asked.
  const nextAsked = () => {
    const waiter = Promise.withResolvers();

    askedNow = waiter;

    return waiter.promise;
  };

  return { layer, lab, nextAsked };
};

// The documents, as a test wants them: in memory, with a write that can be made to fail. The Boosts are written now,
// so a write that fails is a failure the service reports and the change stays owed.
const fakeWriting = () => {
  const files = new Map();
  const failures = new Map();

  return {
    layer: Layer.succeed(Documents)({
      read: (name) => Effect.succeed(files.get(name) ?? null),
      write: (name, contents) =>
        Effect.try({
          try: () => {
            const failure = failures.get(name);

            if (failure) throw failure;

            files.set(name, contents);
          },
          catch: (cause) => new DocumentError({ operation: { name: "document.write", resource: name }, cause }),
        }),
      save: (name, contents) => Effect.sync(() => void files.set(name, contents)),
      settled: Effect.void,
    }),
    files,
    failWrite: (name, cause) => void failures.set(name, cause),
  };
};

const emptyState = () => {
  useBoosts.setState({ loaded: false, error: null, on: true, boosts: {}, scripts: {}, scriptsAcknowledged: false });
};

const loadedState = (boosts = { b1: BOOST }) => {
  useBoosts.setState({ loaded: true, error: null, on: true, boosts, scripts: {}, scriptsAcknowledged: false });
};

const withBoosts = async (use) => {
  const engine = fakeEngine();
  const documents = fakeWriting();
  const diagnostics = fakeDiagnostics();

  emptyState();

  const runtime = ManagedRuntime.make(BoostsService.layer.pipe(Layer.provide(Layer.mergeAll(engine.layer, documents.layer, diagnostics.layer))));

  // The service is built before the test changes the store: it keeps the document in step with it.
  await runtime.runPromise(Effect.void);

  const service = (program) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const boosts = yield* BoostsService;

        return yield* program(boosts);
      }),
    );

  try {
    await use({ engine, documents, diagnostics, runtime, service });
  } finally {
    await runtime.dispose();
  }
};

test("an editor that closes mid-query never receives the answer", async () => {
  await withBoosts(async ({ engine, service }) => {
    const asked = engine.nextAsked();
    const counting = service((boosts) => boosts.counts({ tabId: TAB, generation: "editor-1", selectors: [".ad"] }));

    const query = await asked;

    // The editor closed while the page was counting.
    await service((boosts) => boosts.abandon(TAB, "editor-1"));

    query.gate.resolve();

    const outcome = await counting;

    assert.equal(outcome.kind, "closed", "the closed editor gets no answer");
  });
});

test("a late answer for a replaced editor is dropped", async () => {
  await withBoosts(async ({ engine, service }) => {
    const asked = engine.nextAsked();
    const counting = service((boosts) => boosts.counts({ tabId: TAB, generation: "editor-1", selectors: [".ad"] }));

    const query = await asked;

    // Another editor took over the tab and asked again.
    const askedAgain = engine.nextAsked();
    const second = service((boosts) => boosts.counts({ tabId: TAB, generation: "editor-2", selectors: [".ad"] }));

    const secondQuery = await askedAgain;

    query.gate.resolve();

    const outcome = await counting;

    assert.equal(outcome.kind, "superseded", "the answer belongs to the editor that is waiting for it");

    secondQuery.gate.resolve();
    await second;
  });
});

test("an editor that gave up cannot close the count of the editor that took its place", async () => {
  await withBoosts(async ({ engine, service }) => {
    const asked = engine.nextAsked();
    const counting = service((boosts) => boosts.counts({ tabId: TAB, generation: "editor-1", selectors: [".ad"] }));

    const query = await asked;

    // Another editor took over the tab and asked again.
    const askedAgain = engine.nextAsked();
    const second = service((boosts) => boosts.counts({ tabId: TAB, generation: "editor-2", selectors: [".ad"] }));

    const secondQuery = await askedAgain;

    // The editor that was replaced gives up, late.
    await service((boosts) => boosts.abandon(TAB, "editor-1"));

    secondQuery.gate.resolve();

    const outcome = await second;

    assert.equal(outcome.kind, "counts", "the editor that is waiting for its answer still gets it");

    query.gate.resolve();
    await counting;
  });
});

test("the count that is still wanted is the page's answer", async () => {
  await withBoosts(async ({ engine, service }) => {
    const asked = engine.nextAsked();
    const counting = service((boosts) => boosts.counts({ tabId: TAB, generation: "editor-1", selectors: [".ad", ".sponsored"] }));

    const query = await asked;

    query.gate.resolve([7, 0]);

    const outcome = await counting;

    assert.equal(outcome.kind, "counts");
    assert.deepEqual(outcome.counts, { ".ad": 7, ".sponsored": 0 });
  });
});

test("a Boost with no zaps asks the page nothing", async () => {
  await withBoosts(async ({ engine, service }) => {
    const outcome = await service((boosts) => boosts.counts({ tabId: TAB, generation: "editor-1", selectors: [] }));

    assert.equal(outcome.kind, "counts");
    assert.deepEqual(outcome.counts, {});
    assert.equal(engine.lab.asked.length, 0, "the page was not asked");
  });
});

test("the Boosts are written to the document that holds them", async () => {
  await withBoosts(async ({ documents }) => {
    loadedState();

    assert.ok(documents.files.has("boosts.json"), "the document was written");

    const document = JSON.parse(documents.files.get("boosts.json"));

    assert.equal(document.version, 1, "the document keeps the shape it has always had");
    assert.equal(document.boosts.b1.host, "example.com");
    assert.equal(document.on, true);
  });
});

test("a write that fails is reported and the Boosts stay owed", async () => {
  await withBoosts(async ({ diagnostics, documents, service }) => {
    documents.failWrite("boosts.json", new Error("the disk is full"));

    // The Boosts change: the document is written, and the write fails.
    loadedState();

    assert.equal(documents.files.has("boosts.json"), false, "nothing was written");
    assert.equal(diagnostics.reports.length, 1, "the failure was reported");
    assert.equal(diagnostics.reports[0].operation.name, "boosts.save");

    // The Boosts are still owed: the next save tries again.
    const again = await service((boosts) => boosts.save);

    assert.equal(again.kind, "failed", "the change is still owed");
    assert.equal(diagnostics.reports.length, 2, "the failure is reported again");
  });
});

test("a document that cannot be read is kept as it is", async () => {
  await withBoosts(async ({ documents, service }) => {
    useBoosts.setState({ loaded: true, error: "Couldn't read Boosts: it isn't one", on: true, boosts: { b1: BOOST }, scripts: {}, scriptsAcknowledged: false });

    const outcome = await service((boosts) => boosts.save);

    assert.equal(outcome.kind, "saved", "there was nothing to write");
    assert.equal(documents.files.has("boosts.json"), false, "the file was not overwritten");
  });
});

test("a script runs only where the user allowed it", () => {
  const scripts = { b1: { code: "console.log(1)", enabled: true, privateWindows: false } };
  const [engine] = engineBoosts([BOOST], scripts, true);

  assert.equal(engine.scriptInPrivate, false, "a script doesn't run in private windows unless allowed");

  const [allowed] = engineBoosts([BOOST], { b1: { code: "console.log(1)", enabled: true, privateWindows: true } }, true);

  assert.equal(allowed.scriptInPrivate, true, "the private-window opt-in lets it run there");

  const [off] = engineBoosts([BOOST], { b1: { code: "console.log(1)", enabled: false, privateWindows: true } }, true);

  assert.equal(off.script, "", "a script that is off runs nowhere");
});

test("a synced Boost cannot turn a script on for another site", () => {
  emptyState();
  useBoosts.setState({
    loaded: true,
    error: null,
    on: true,
    boosts: { b1: BOOST },
    scripts: { b1: { code: "console.log(1)", enabled: true, privateWindows: true } },
    scriptsAcknowledged: true,
  });

  // Another Mac syncs the same Boost for a different site.
  applySyncedBoosts([{ ...BOOST, host: "other.com" }], []);

  const script = useBoosts.getState().scripts.b1;

  assert.equal(script.enabled, false, "a synced host edit turns the script off");
  assert.equal(script.privateWindows, false, "the private-window opt-in goes with it");
});

test("the document holds the Boosts, the scripts and the switch", () => {
  const document = { on: false, boosts: { b1: BOOST }, scripts: { b1: { code: "x", enabled: false, privateWindows: false } }, scriptsAcknowledged: true };
  const written = JSON.parse(boostDocumentJson(document));

  assert.deepEqual(Object.keys(written).sort(), ["boosts", "on", "scripts", "scriptsAcknowledged", "version"]);
  assert.equal(written.boosts.b1.host, "example.com");
  assert.equal(written.scripts.b1.enabled, false, "a script is off until the user turns it on");
});
