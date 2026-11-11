// The media work (components/media/service.ts): the share picker's screens, the cast dialogs and the task manager's
// poll, against a fake engine and the test clock.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as TestClock from "effect/testing/TestClock";

const { useBrowser } = await import("../../store/browserStore.ts");
const { usePages } = await import("../window/pageState.ts");
const { fakeDiagnostics } = await import("../../effect/testing.ts");
const { useMedia } = await import("./state.ts");
const { MediaEngine, MediaService, useCast } = await import("./service.ts");
const { SHARE_SOURCES_REFRESH_MS } = await import("./constants.ts");
const { TASK_POLL_MS } = await import("../taskManager/constants.ts");

const TAB = "page";

const screen = (id) => ({ id, kind: "screen", title: id });

const fakeEngine = (lab) =>
  Layer.succeed(MediaEngine)({
    sources: () => Effect.sync(() => (lab.sourceCalls++, [screen(`screen-${lab.sourceCalls}`)])),
    resolveDisplayMedia: (tabId, requestId, sourceId) =>
      Effect.gen(function* () {
        lab.answers.push({ tabId, requestId, sourceId });

        if (lab.answerGate?.requestId === requestId) {
          lab.answerGate.started.resolve();
          yield* Effect.promise(() => lab.answerGate.finished.promise);
        }
      }),
    captureSourceId: (tabId) =>
      Effect.promise(async () => {
        if (lab.captureGate) await lab.captureGate.promise;

        return `capture:${tabId}`;
      }),
    onCastDialog: (listener) =>
      Effect.sync(() => {
        lab.dialogListeners.push(listener);

        return () => (lab.dialogListeners = lab.dialogListeners.filter((l) => l !== listener));
      }),
    onCastRoutes: (listener) =>
      Effect.sync(() => {
        lab.routeListeners.push(listener);

        return () => (lab.routeListeners = lab.routeListeners.filter((l) => l !== listener));
      }),
    showCastDialog: (browserId) => Effect.sync(() => void lab.shown.push(browserId)),
    closeCastDialog: (dialogId) => Effect.sync(() => void lab.closed.push(dialogId)),
    watchCastRoutes: (profile) => Effect.sync(() => void lab.watched.push(profile)),
    usePicker: () => Effect.sync(() => void lab.pickers++),
    setAutoPictureInPicture: (on) => Effect.sync(() => void lab.autoPip.push(on)),
    tasks: () => Effect.sync(() => (lab.taskCalls++, [{ id: lab.taskCalls }])),
    killTask: (id) => Effect.sync(() => void lab.killed.push(id)),
  });

const withMedia = async (use) => {
  const lab = {
    answers: [],
    answerGate: null,
    autoPip: [],
    captureGate: null,
    closed: [],
    dialogListeners: [],
    killed: [],
    pickers: 0,
    routeListeners: [],
    shown: [],
    sourceCalls: 0,
    taskCalls: 0,
    watched: [],
  };

  const diagnostics = fakeDiagnostics();

  const runtime = ManagedRuntime.make(
    Layer.mergeAll(MediaService.layer.pipe(Layer.provide(Layer.mergeAll(fakeEngine(lab), diagnostics.layer))), TestClock.layer()),
  );

  useBrowser.setState({
    tabs: { [TAB]: { id: TAB, spaceId: "default", url: "https://meet.example/room", windowId: "w1" } },
    windows: { w1: { id: "w1", spaceId: "default", activeTabIds: { default: TAB } } },
    windowOrder: ["w1"],
  });
  useMedia.setState({ displayRequests: {} });
  useCast.setState({ dialogs: {}, routes: {} });
  usePages.setState({ browsers: { 7: TAB } });

  const media = (program) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* MediaService;

        return yield* program(service);
      }),
    );

  const advance = (ms) => runtime.runPromise(TestClock.adjust(ms));

  try {
    await use({ lab, media, advance, runtime });
  } finally {
    await runtime.dispose();
  }
};

const request = (id) => ({ id, origin: "https://meet.example", audio: false, sources: [screen("first")] });

test("an open picker keeps its list fresh, and stops when it closes", async () => {
  await withMedia(async ({ lab, media, advance }) => {
    const seen = [];

    await media((service) => service.requestDisplayMedia(TAB, request("r1")));
    await media((service) => service.watchSources(TAB, "r1", (sources) => seen.push(sources)));

    await advance(SHARE_SOURCES_REFRESH_MS);
    assert.equal(lab.sourceCalls, 1, "the engine is asked once a refresh");
    assert.equal(seen.length, 1);

    await media((service) => service.stopSources(TAB, "r1"));
    await advance(SHARE_SOURCES_REFRESH_MS * 3);
    assert.equal(lab.sourceCalls, 1, "a closed picker asks nothing");
  });
});

test("a request is answered once, and a replaced one never", async () => {
  await withMedia(async ({ lab, media, advance }) => {
    await media((service) => service.requestDisplayMedia(TAB, request("r1")));
    await media((service) => service.watchSources(TAB, "r1", () => {}));

    // A second request replaces the first: the first is answered with nothing.
    await media((service) => service.requestDisplayMedia(TAB, request("r2")));
    assert.deepEqual(lab.answers, [{ tabId: TAB, requestId: "r1", sourceId: null }]);

    // The old picker's choice comes late: it is not an answer to the new request.
    await media((service) => service.answerDisplayMedia(TAB, "r1", "screen-a"));
    assert.equal(lab.answers.length, 1);

    await media((service) => service.answerDisplayMedia(TAB, "r2", "screen-b"));
    await media((service) => service.answerDisplayMedia(TAB, "r2", "screen-c"));
    assert.deepEqual(lab.answers.at(-1), { tabId: TAB, requestId: "r2", sourceId: "screen-b" });
    assert.equal(lab.answers.length, 2, "a second choice finds nothing to answer");

    const calls = lab.sourceCalls;

    await advance(SHARE_SOURCES_REFRESH_MS * 3);
    assert.equal(lab.sourceCalls, calls, "the replaced picker's poll ended with its request");
  });
});

test("a tab chosen after the picker was cancelled does not answer", async () => {
  await withMedia(async ({ lab, media }) => {
    await media((service) => service.requestDisplayMedia(TAB, request("r1")));

    lab.captureGate = Promise.withResolvers();

    const sharing = media((service) => service.shareTab(TAB, "r1", "other"));

    await media((service) => service.answerDisplayMedia(TAB, "r1", null));
    lab.captureGate.resolve();

    assert.equal(await sharing, null);
    assert.deepEqual(lab.answers, [{ tabId: TAB, requestId: "r1", sourceId: null }], "only the cancellation answered");
  });
});

test("a delayed cancellation cannot replace a newer screen-sharing request", async () => {
  await withMedia(async ({ lab, media }) => {
    await media((service) => service.requestDisplayMedia(TAB, request("A")));

    lab.answerGate = { requestId: "A", started: Promise.withResolvers(), finished: Promise.withResolvers() };

    const replacing = media((service) => service.requestDisplayMedia(TAB, request("B")));

    try {
      await lab.answerGate.started.promise;
      await media((service) => service.requestDisplayMedia(TAB, request("C")));
      assert.equal(useMedia.getState().displayRequests[TAB]?.id, "C");
    } finally {
      lab.answerGate.finished.resolve();
      await replacing;
    }

    assert.equal(useMedia.getState().displayRequests[TAB]?.id, "C", "the latest request keeps its picker");
    await media((service) => service.answerDisplayMedia(TAB, "C", "screen-c"));

    assert.deepEqual(lab.answers, [
      { tabId: TAB, requestId: "A", sourceId: null },
      { tabId: TAB, requestId: "B", sourceId: null },
      { tabId: TAB, requestId: "C", sourceId: "screen-c" },
    ]);
    assert.equal(useMedia.getState().displayRequests[TAB], undefined);
  });
});

test("a page that moves on cancels its request", async () => {
  await withMedia(async ({ lab, media }) => {
    await media((service) => service.start);
    await media((service) => service.requestDisplayMedia(TAB, request("r1")));

    useBrowser.setState((s) => ({ tabs: { ...s.tabs, [TAB]: { ...s.tabs[TAB], url: "https://other.example/" } } }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(lab.answers, [{ tabId: TAB, requestId: "r1", sourceId: null }]);
    assert.equal(useMedia.getState().displayRequests[TAB], undefined);
  });
});

test("the app's listeners are registered once, and given back when the runtime closes", async () => {
  let lab;

  await withMedia(async (context) => {
    lab = context.lab;

    await context.media((service) => service.start);
    await context.media((service) => service.start);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(lab.dialogListeners.length, 1);
    assert.equal(lab.routeListeners.length, 1);
    assert.equal(lab.pickers, 1);
    assert.equal(lab.watched.length, 1, "a profile is watched once");

    lab.dialogListeners[0]({ id: 3, browserId: 7, open: true, sinks: [] });
    assert.equal(useCast.getState().dialogs[TAB]?.id, 3);

    await context.media((service) => service.toggleCastPicker("w1"));
    assert.deepEqual(lab.closed, [3], "an open dialog is closed by the toggle");

    // A dialog for a page the app no longer shows is closed at once.
    lab.dialogListeners[0]({ id: 9, browserId: 99, open: true, sinks: [] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(lab.closed, [3, 9]);
  });

  assert.equal(lab.dialogListeners.length, 0);
  assert.equal(lab.routeListeners.length, 0);
});

test("two task managers share one poll, and the last to close ends it", async () => {
  await withMedia(async ({ lab, media, advance }) => {
    const first = [];
    const second = [];

    await media((service) => service.watchTasks("a", (tasks) => first.push(tasks)));
    await media((service) => service.watchTasks("b", (tasks) => second.push(tasks)));
    await advance(0);

    const calls = lab.taskCalls;

    await advance(TASK_POLL_MS);
    assert.equal(lab.taskCalls, calls + 1, "one poll for both windows");
    assert.equal(first.length, second.length);

    await media((service) => service.stopTasks("a"));
    await advance(TASK_POLL_MS);
    assert.equal(lab.taskCalls, calls + 2, "the poll goes on while a window is open");

    await media((service) => service.stopTasks("b"));
    await advance(TASK_POLL_MS * 3);
    assert.equal(lab.taskCalls, calls + 2, "no window, no poll");

    await media((service) => service.endTask(4));
    assert.deepEqual(lab.killed, [4]);
  });
});
