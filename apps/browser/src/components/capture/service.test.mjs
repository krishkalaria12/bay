import { ReadBrowser } from "../../effect/windowPorts.ts";
// Capture (components/capture/service.ts): the selection, the picture and what is done with it, against a fake page
// and a fake Mac.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const { useBrowser } = await import("../../store/browserStore.ts");
const { useToasts } = await import("../ui/toasts.ts");
const { fakeDiagnostics } = await import("../../effect/testing.ts");
const { LibraryService } = await import("../library/libraryService.ts");
const { CaptureEngine, CaptureService, sessionOf, useCaptures } = await import("./service.ts");

const TAB = "page";

const image = (path) => ({ path, width: 100, height: 80 });

const fakeEngine = (lab) =>
  Layer.succeed(CaptureEngine)({
    hasPage: () => true,
    evaluate: (tabId, script) =>
      Effect.sync(() => {
        const on = script.startsWith("const ON = true");

        lab.scripts.push(on ? "on" : "off");

        return on ? lab.installs : true;
      }),
    focus: () => Effect.sync(() => void lab.focused++),
    screenScale: () => 2,
    shoot: (tabId, options) =>
      Effect.promise(async () => {
        lab.shots.push(options);
        lab.reached?.resolve();

        if (lab.gate) await lab.gate.promise;

        return lab.paints ? image(`/tmp/shot-${lab.shots.length}.png`) : null;
      }),
    screenshot: () => Effect.succeed(lab.paints ? "png-bytes" : null),
    copyPng: () => Effect.sync(() => (lab.copied.push("png"), true)),
    copy: (path) => Effect.sync(() => (lab.copied.push(path), true)),
    save: (path, name) => Effect.sync(() => (lab.saved.push(name), lab.saves ? `/Users/me/Downloads/${name}.png` : null)),
    share: () => Effect.void,
    portrait: (path) => Effect.succeed(image(`${path}.framed`)),
    reveal: () => {},
    libraryWindow: (windowId) => windowId,
    chooseEasel: () => Effect.succeed(true),
  });

const withCapture = async (use) => {
  const lab = {
    copied: [],
    focused: 0,
    gate: null,
    installs: true,
    library: [],
    paints: true,
    reached: null,
    saved: [],
    saves: true,
    scripts: [],
    shots: [],
  };

  const library = Layer.succeed(LibraryService)({
    start: Effect.void,
    saveMedia: (picture, name) => Effect.sync(() => (lab.library.push(name), { id: `media-${lab.library.length}`, name })),
  });

  const runtime = ManagedRuntime.make(
    CaptureService.layer.pipe(Layer.provide(ReadBrowser.layer(useBrowser)), Layer.provide(Layer.mergeAll(fakeEngine(lab), library, fakeDiagnostics().layer))),
  );

  useBrowser.setState({
    tabs: { [TAB]: { id: TAB, spaceId: "default", url: "https://example.com/article", title: "An article", windowId: "w1" } },
  });
  useCaptures.setState({ sessions: {} });
  useToasts.setState({ toasts: {} });

  const capture = (program) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* CaptureService;

        return yield* program(service);
      }),
    );

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  try {
    await use({ lab, capture, settle });
  } finally {
    await runtime.dispose();
  }
};

const toast = () => useToasts.getState().toasts.w1?.title;

const area = { type: "capture", x: 0, y: 0, left: 0, top: 0, width: 40, height: 30, viewportWidth: 800, viewportHeight: 600 };

test("a selection is put into the page, and a picture of the area comes out of it", async () => {
  await withCapture(async ({ lab, capture, settle }) => {
    await capture((service) => service.begin(TAB));
    await settle();

    assert.deepEqual(lab.scripts, ["on"]);
    assert.equal(sessionOf(TAB)?.phase, "selecting");

    await capture((service) => service.message(TAB, area));
    await settle();

    assert.equal(sessionOf(TAB)?.phase, "ready");
    assert.deepEqual(lab.shots[0].clip, [0, 0, 40, 30]);
    assert.equal(lab.shots[0].pixelRatio, 2, "the picture is at the screen's scale");
  });
});

test("a capture put away while it was taken never comes back", async () => {
  await withCapture(async ({ lab, capture, settle }) => {
    await capture((service) => service.begin(TAB));
    await settle();

    lab.gate = Promise.withResolvers();
    lab.reached = Promise.withResolvers();

    await capture((service) => service.message(TAB, area));
    await lab.reached.promise;
    assert.equal(sessionOf(TAB)?.phase, "shooting");

    await capture((service) => service.close(TAB));
    lab.gate.resolve();
    await settle();

    assert.equal(sessionOf(TAB), null, "the late picture is not shown");
  });
});

test("a page that leaves takes its selection out, and a closed tab ends its capture", async () => {
  await withCapture(async ({ lab, capture, settle }) => {
    await capture((service) => service.start);
    await capture((service) => service.begin(TAB));
    await settle();

    useBrowser.setState((s) => ({ tabs: { ...s.tabs, [TAB]: { ...s.tabs[TAB], url: "https://example.com/next" } } }));
    await settle();

    assert.equal(sessionOf(TAB), null);
    assert.deepEqual(lab.scripts, ["on", "off"], "the selection is taken out once");

    useBrowser.setState((s) => ({ tabs: { ...s.tabs, [TAB]: { ...s.tabs[TAB], url: "https://example.com/next" } } }));
    await capture((service) => service.begin(TAB));
    await settle();

    lab.gate = Promise.withResolvers();
    lab.reached = Promise.withResolvers();

    await capture((service) => service.message(TAB, area));
    await lab.reached.promise;

    useBrowser.setState({ tabs: {} });
    lab.gate.resolve();
    await settle();

    assert.equal(sessionOf(TAB), null, "a closed tab's picture is not shown");
  });
});

test("a save that failed never says it saved", async () => {
  await withCapture(async ({ lab, capture, settle }) => {
    await capture((service) => service.begin(TAB));
    await settle();
    await capture((service) => service.message(TAB, area));
    await settle();

    lab.saves = false;

    await capture((service) => service.save(TAB));

    assert.equal(toast(), "Couldn’t Save the Capture");
    assert.equal(sessionOf(TAB), null, "the capture is put away");
  });
});

test("a page that did not paint says so", async () => {
  await withCapture(async ({ lab, capture, settle }) => {
    lab.paints = false;

    await capture((service) => service.begin(TAB));
    await settle();
    await capture((service) => service.message(TAB, area));
    await settle();

    assert.equal(sessionOf(TAB), null);
    assert.equal(toast(), "Couldn’t Capture the Page");
  });
});

test("Portrait copies the framed picture, and keeps it in Downloads and the Library", async () => {
  await withCapture(async ({ lab, capture, settle }) => {
    await capture((service) => service.portrait(TAB));
    await settle();

    assert.equal(lab.shots[0].pixelRatio, 2, "Portrait is at 2×");
    assert.match(lab.copied[0], /framed$/);
    assert.equal(lab.saved.length, 1);
    assert.equal(lab.library.length, 1);
    assert.equal(toast(), "Copied Portrait Capture");
  });
});

test("the developer's screenshot is copied, or says why not", async () => {
  await withCapture(async ({ lab, capture }) => {
    await capture((service) => service.screenshot(TAB));
    assert.deepEqual(lab.copied, ["png"]);
    assert.equal(toast(), "Copied Screenshot");

    lab.paints = false;

    await capture((service) => service.screenshot(TAB));
    assert.equal(toast(), "Couldn’t Take a Screenshot");
  });
});
