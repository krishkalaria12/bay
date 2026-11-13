import { ReadBrowser } from "../../effect/windowPorts.ts";
// The import workflow (components/import/workflow.ts): the native job, the order the data lands in, and what the
// user is asked for.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Predicate from "effect/Predicate";
import * as TestClock from "effect/testing/TestClock";

const { useBrowser } = await import("../../store/browserStore.ts");
const { ImportEngine, ImportFailure, ImportWorkflow } = await import("./workflow.ts");

const S = () => useBrowser.getState();

const source = {
  id: "chrome",
  name: "Chrome",
  family: "chromium",
  needsFullDiskAccess: false,
  requiresExport: false,
  needsKeychain: true,
  profiles: [
    { id: "one", name: "One", path: "", isDefault: true, available: ["bookmarks", "history"] },
    { id: "two", name: "Two", path: "", isDefault: false, available: ["bookmarks", "history"] },
  ],
};

// Chrome's bookmarks, as the native module gives them.
const bookmarks = (title) => ({ type: "folder", title, children: [{ type: "url", url: `https://${title}.example/`, title }] });

const fakeEngine = () => {
  const lab = {
    diaStatuses: [],
    statusChecks: 0,
    asked: [],
    jobs: [],
    nativeJobs: [],
    unlocked: 0,
    forgotten: 0,
    reads: 0,
    // What each profile's import does: a result, or a code it refuses with.
    answers: new Map(),
  };

  const layer = Layer.succeed(ImportEngine)({
    listBrowsers: () => Effect.succeed([source]),
    unlockBrowser: () =>
      Effect.sync(() => {
        lab.unlocked++;
      }),
    isBrowserUnlocked: () => false,
    forgetUnlockedKeys: () => {
      lab.forgotten++;
    },
    importData: (job) =>
      Effect.suspend(() => {
        lab.asked.push(job.profileId);
        lab.jobs.push(job);

        const configured = lab.answers.get(job.profileId);
        const answer = Predicate.isFunction(configured) ? configured(job) : configured;

        if (Predicate.isString(answer)) return Effect.fail(new ImportFailure({ code: answer, operation: "import.data", cause: new Error(answer) }));

        return Effect.succeed(
          answer ?? {
            browserId: job.browserId,
            profileId: job.profileId,
            profile: { name: job.profileId },
            spaces: [],
            bookmarks: bookmarks(job.profileId),
            history: [],
            tabs: [],
            favorites: [],
            credentials: [],
            warnings: [],
            failed: [],
            vaultToken: undefined,
            cookieCount: 0,
            addressCount: 0,
            cardCount: 0,
            extensions: [],
          },
        );
      }),
    importNative: (job) => {
      lab.nativeJobs.push(job);

      return Promise.resolve({ vaultToken: undefined, failed: [] });
    },
    discardImported: () => {},
    importSafariExport: () => Effect.succeed({ profiles: [], bookmarks: undefined, passwordCSV: undefined }),
    importSafariDirect: () => Effect.succeed({ profiles: [], bookmarks: undefined, passwordCSV: undefined }),
    importBookmarksHTML: () => Effect.succeed({ type: "folder", title: "", children: [] }),
    chooseImportFile: () => Effect.succeed(null),
    safariHasFullDiskAccess: () => true,
    diaAutomationStatus: () => Effect.sync(() => (lab.statusChecks++, lab.diaStatuses.shift() ?? "granted")),
    requestDiaAutomation: () => Effect.succeed("granted"),
    openDia: () => Effect.void,
    readDiaTabs: () =>
      Effect.sync(() => {
        lab.reads++;

        return { profiles: [], windowCount: 0, skipped: 0, duplicates: 0 };
      }),
  });

  return { layer, lab };
};

const withWorkflow = async (use) => {
  const engine = fakeEngine();

  const runtime = ManagedRuntime.make(
    Layer.mergeAll(ImportWorkflow.layer.pipe(Layer.provide(ReadBrowser.layer(useBrowser)), Layer.provide(engine.layer)), TestClock.layer()),
  );

  try {
    await use({ lab: engine.lab, runtime });
  } finally {
    await runtime.dispose();
  }
};

const request = (signal = new AbortController().signal) => ({
  source,
  profileIds: ["one", "two"],
  spaceIds: [],
  kinds: new Set(["bookmarks"]),
  target: "default",
  signal,
  onProgress: () => {},
});

test("a cancelled import stops the run, and the keychain item is given back", async () => {
  await withWorkflow(async ({ lab, runtime }) => {
    lab.answers.set("one", "cancelled");

    const failure = await runtime
      .runPromise(
        Effect.gen(function* () {
          const workflow = yield* ImportWorkflow;

          return yield* workflow.import(request());
        }),
      )
      .then(
        () => null,
        (error) => error,
      );

    assert.ok(failure instanceof ImportFailure);
    assert.equal(failure.code, "cancelled");
    assert.deepEqual(lab.asked, ["one"], "no later profile begins");
    assert.equal(lab.forgotten, 1, "the keychain item is given back");
  });
});

test("a profile that fails does not stop the others", async () => {
  await withWorkflow(async ({ lab, runtime }) => {
    lab.answers.set("one", "unreadable");

    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const workflow = yield* ImportWorkflow;

        return yield* workflow.import(request());
      }),
    );

    assert.deepEqual(lab.asked, ["one", "two"]);
    assert.equal(outcome.failures.length, 1);
    assert.equal(outcome.failures[0].kind, "bookmarks");
    assert.deepEqual(outcome.failures[0].profiles, ["One"]);
    assert.equal(lab.forgotten, 1);
  });
});

test("the data lands in the chosen space, and the counts say what came", async () => {
  await withWorkflow(async ({ lab, runtime }) => {
    S().hydrate({});

    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const workflow = yield* ImportWorkflow;

        return yield* workflow.import({ ...request(), profileIds: ["one"] });
      }),
    );

    assert.equal(outcome.counts.bookmarks, 1);
    assert.equal(outcome.failures.length, 0);
    assert.ok(
      Object.values(S().bookmarks.nodes).some((node) => node.title === "one"),
      "the bookmark landed in the space",
    );
    assert.equal(lab.forgotten, 1);
  });
});

test("the browser's keychain item is opened once, and only when it is needed", async () => {
  await withWorkflow(async ({ lab, runtime }) => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const workflow = yield* ImportWorkflow;

        yield* workflow.unlock("chrome");
      }),
    );

    assert.equal(lab.unlocked, 1);
  });
});

test("Arc imports only the chosen spaces and keeps that selection when rereading native data", async () => {
  await withWorkflow(async ({ lab, runtime }) => {
    S().hydrate({});

    const spaces = ["personal", "work", "travel"].map((id) => ({ id, name: id, profileId: "one", pinned: [], tabs: [] }));
    const selected = ["personal", "travel"];
    const arc = { ...source, id: "arc", family: "arc", profiles: [{ ...source.profiles[0], spaces }] };

    lab.answers.set("one", (job) => ({
      browserId: "arc",
      profileId: "one",
      spaces: spaces.filter((space) => !job.spaceIds || job.spaceIds.includes(space.id)),
      history: [],
      tabs: [],
      favorites: [],
      credentials: [],
      warnings: [],
      failed: [],
      vaultToken: "first-destination-token",
      cookieCount: 1,
      addressCount: 0,
      cardCount: 0,
      extensions: [],
    }));

    await runtime.runPromise(
      Effect.gen(function* () {
        const workflow = yield* ImportWorkflow;

        return yield* workflow.import({ ...request(), source: arc, profileIds: [], spaceIds: selected, kinds: new Set(["tabs", "cookies"]) });
      }),
    );

    assert.deepEqual(lab.jobs[0].spaceIds, selected, "the native import receives the selected spaces");
    assert.equal(S().spaceOrder.length, 2, "a deselected space does not create a destination");
    assert.equal(lab.nativeJobs.length, 1, "the second chosen space gets a fresh native token");
    assert.deepEqual(lab.nativeJobs[0].spaceIds, selected, "the native reread keeps the same space selection");
  });
});

test("Dia's read waits for a window, and gives up within the launch grace", async () => {
  await withWorkflow(async ({ lab, runtime }) => {
    let reads = 0;

    await runtime.runPromise(
      Effect.gen(function* () {
        const workflow = yield* ImportWorkflow;

        yield* workflow.openDia();
      }),
    );

    assert.equal(lab.asked.length, 0);

    const reading = runtime.runPromise(
      Effect.gen(function* () {
        const workflow = yield* ImportWorkflow;

        return yield* workflow.readDiaTabs();
      }),
    );

    // Dia has no window yet: the read is retried until the poll cap.
    for (let i = 0; i < 8; i++) {
      await runtime.runPromise(TestClock.adjust(1_500));
      reads++;
    }

    await reading;
    assert.equal(reads, 8);
    assert.equal(lab.reads, 9, "the first read, and one for each retry");
  });
});

test("the wait for Dia asks until it runs, and asks nothing once the flow closes", async () => {
  await withWorkflow(async ({ lab, runtime }) => {
    const wait = (signal) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const workflow = yield* ImportWorkflow;

          return yield* workflow.waitForDia(signal);
        }),
      );

    lab.diaStatuses.push("notRunning", "notRunning", "granted");

    const waiting = wait(new AbortController().signal);

    for (let i = 0; i < 3; i++) await runtime.runPromise(TestClock.adjust(1_500));

    assert.equal(await waiting, "granted");
    assert.equal(lab.statusChecks, 3);

    // The flow closed while it waited: nothing more is asked.
    const closing = new AbortController();

    lab.diaStatuses.push("notRunning");

    const stopped = wait(closing.signal);

    await runtime.runPromise(TestClock.adjust(1_500));
    closing.abort();
    await runtime.runPromise(TestClock.adjust(1_500 * 4));

    assert.equal(await stopped, "notRunning");
    assert.equal(lab.statusChecks, 4, "no ask after the flow closed");
  });
});
