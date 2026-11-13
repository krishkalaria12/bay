import { ReadBrowser } from "../../effect/windowPorts.ts";
// The page work (components/site/pageWorkService.ts): a document's translation, and the checks around it.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as TestClock from "effect/testing/TestClock";

const { useBrowser } = await import("../../store/browserStore.ts");
const { PageWorkEngine, PageWorkFailure, PageWorkService, translateStateOf, useTranslate } = await import("./pageWorkService.ts");

const TAB = "page";

const question = {
  title: "Open this page in Safari's engine?",
  message: "The page reloads in WebKit, so changes you made on it may not be saved.",
  confirmTitle: "Open in WebKit",
  cancelTitle: "Stay on Page",
  windowId: "w1",
};

// A page that answers what the service asks, and keeps what it was told.
const fakePage = (lab) => ({
  identity: () => Effect.succeed(lab.token),
  sample: () => Effect.sync(() => (lab.samples++, { lang: "fr", text: lab.text, active: lab.token !== null })),
  start: (token) =>
    Effect.sync(() => {
      lab.token = token;
      lab.started.push(token);

      return true;
    }),
  next: (token) =>
    Effect.sync(() => {
      lab.asked.push(token);

      return lab.batches.shift() ?? { passages: [], more: false, gone: false, done: 0, total: 0 };
    }),
  apply: (results) =>
    Effect.sync(() => {
      lab.applied.push(results);

      return true;
    }),
  revert: () =>
    Effect.sync(() => {
      lab.token = null;
      lab.reverts++;

      return true;
    }),
  unsavedWork: () => Effect.succeed(lab.unsaved),
});

const fakeEngine = (lab) =>
  Layer.succeed(PageWorkEngine)({
    available: () => Effect.succeed(true),
    view: () => Effect.succeed(fakePage(lab)),
    userLanguages: () => Effect.succeed(["en-US", "fr-FR"]),
    languageName: (language) => Effect.succeed(language),
    detect: () => Effect.succeed("fr"),
    status: () => Effect.succeed("supported"),
    supportedLanguages: () => Effect.succeed(["de-DE", "fr-FR", "fr-CA"]),
    prepare: () =>
      Effect.suspend(() => {
        if (lab.prepareFailure) return Effect.fail(new PageWorkFailure({ operation: { name: "translation.prepare" }, cause: lab.prepareFailure }));

        return Effect.sync(() => void lab.prepared++);
      }),
    translate: (source, target, texts) => Effect.sync(() => texts.map((text) => `de:${text}`)),
    translateBlocks: (source, target, blocks) =>
      Effect.promise(async () => {
        lab.translated++;
        lab.reached?.resolve();

        if (lab.gate) await lab.gate.promise;

        return blocks.map((block) => block.map((text) => `de:${text}`));
      }),
    ask: (asked) =>
      Effect.sync(() => {
        lab.questions.push(asked);

        return lab.confirmed;
      }),
  });

const withWork = async (use) => {
  const lab = {
    applied: [],
    asked: [],
    batches: [],
    confirmed: false,
    gate: null,
    prepared: 0,
    prepareFailure: null,
    reached: null,
    questions: [],
    reverts: 0,
    samples: 0,
    started: [],
    text: "Bonjour, le monde. ".repeat(4),
    token: null,
    translated: 0,
    unsaved: false,
  };

  const runtime = ManagedRuntime.make(
    Layer.mergeAll(PageWorkService.layer.pipe(Layer.provide(ReadBrowser.layer(useBrowser)), Layer.provide(fakeEngine(lab))), TestClock.layer()),
  );

  useBrowser.setState({
    tabs: {
      [TAB]: { id: TAB, spaceId: "default", url: "https://example.com/", windowId: "w1", navigation: { url: "https://example.com/", seq: 1 } },
    },
  });
  useTranslate.setState({});

  const work = (program) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* PageWorkService;

        return yield* program(service);
      }),
    );

  try {
    await use({ lab, runtime, work });
  } finally {
    await runtime.dispose();
  }
};

const passage = { passages: [[1, [[1, "Bonjour"]]]], more: false, gone: false, done: 1, total: 1 };

test("a document that was replaced never gets a late result", async () => {
  await withWork(async ({ lab, work }) => {
    lab.batches.push(passage);
    lab.gate = Promise.withResolvers();
    lab.reached = Promise.withResolvers();

    const translating = work((service) => service.translate(TAB, { target: "de" }));

    await lab.reached.promise;

    // The page was replaced while the passages were being translated.
    lab.token = null;
    lab.gate.resolve();

    const outcome = await translating;

    assert.equal(outcome.kind, "stopped", "the translation did not finish");
    assert.deepEqual(lab.applied, [], "the late result was not put into the page");
    assert.equal(translateStateOf(TAB).status, "idle", "the replaced document is not translated");
  });
});

test("a model preparation failure reports its native error", async () => {
  await withWork(async ({ lab, work }) => {
    lab.prepareFailure = new Error("Not enough disk space to download the translation model.");

    const outcome = await work((service) => service.translate(TAB, { target: "de" }));

    assert.deepEqual(outcome, { kind: "failed", reason: "Not enough disk space to download the translation model" });
    assert.equal(translateStateOf(TAB).status, "idle");
  });
});

test("a revert stops the follow loop", async () => {
  await withWork(async ({ lab, runtime, work }) => {
    lab.batches.push(passage);

    const outcome = await work((service) => service.translate(TAB, { target: "de" }));

    assert.equal(outcome.kind, "translated");
    assert.equal(translateStateOf(TAB).status, "translated");

    const followed = lab.asked.length;

    await runtime.runPromise(TestClock.adjust(600));
    assert.equal(lab.asked.length, followed + 1, "the page is followed while it changes");

    await work((service) => service.revert(TAB));

    const afterRevert = lab.asked.length;

    await runtime.runPromise(TestClock.adjust(600));
    assert.equal(lab.asked.length, afterRevert, "a revert stops the following");
    assert.equal(translateStateOf(TAB).status, "idle");
  });
});

test("a document that was replaced ends the follow loop", async () => {
  await withWork(async ({ lab, runtime, work }) => {
    lab.batches.push(passage);

    await work((service) => service.translate(TAB, { target: "de" }));

    const followed = lab.asked.length;

    // The page was replaced: it is a new document, with no translation of its own.
    lab.token = null;

    await runtime.runPromise(TestClock.adjust(600));
    assert.equal(lab.asked.length, followed + 1, "the page is asked one more time");
    assert.equal(translateStateOf(TAB).status, "idle", "the replaced document is no longer translated");

    const afterReplacement = lab.asked.length;

    await runtime.runPromise(TestClock.adjust(600));
    assert.equal(lab.asked.length, afterReplacement, "the following stops with the document");
  });
});

test("the engine switch asks before it moves a page that holds work", async () => {
  await withWork(async ({ lab, work }) => {
    lab.unsaved = true;
    lab.confirmed = false;

    const refused = await work((service) => service.mayLeavePage(TAB, question));

    assert.equal(refused, false, "the page stays where it is");
    assert.equal(lab.questions.length, 1, "the user was asked");
    assert.equal(lab.questions[0].confirmTitle, "Open in WebKit");
  });
});

test("the engine switch goes ahead when the user says so", async () => {
  await withWork(async ({ lab, work }) => {
    lab.unsaved = true;
    lab.confirmed = true;

    const allowed = await work((service) => service.mayLeavePage(TAB, question));

    assert.equal(allowed, true);
    assert.equal(lab.questions.length, 1, "the user was asked");
  });
});

test("the engine switch goes ahead without asking when the page holds nothing", async () => {
  await withWork(async ({ lab, work }) => {
    lab.unsaved = false;

    const allowed = await work((service) => service.mayLeavePage(TAB, question));

    assert.equal(allowed, true);
    assert.deepEqual(lab.questions, [], "there was nothing to ask about");
  });
});

test("a page that finished loading is read for its language, and a closed tab's state goes", async () => {
  await withWork(async ({ lab, work }) => {
    await work((service) => service.start);
    await work((service) => service.start);

    useBrowser.setState((s) => ({ live: { ...s.live, [TAB]: { isLoading: true } } }));
    useBrowser.setState((s) => ({ live: { ...s.live, [TAB]: { isLoading: false } } }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(lab.samples, 1, "the page is read once it loaded, by one watch");

    useBrowser.setState({ tabs: {} });
    assert.equal(useTranslate.getState()[TAB], undefined, "the closed tab's state is forgotten");
  });
});
