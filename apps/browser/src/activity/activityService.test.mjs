// The live folders' refresh (activity/activityService.ts): one job per folder, and what a provider's failure does
// to the others' items.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const { useBrowser } = await import("../store/browserStore.ts");
const { ActivityService, LiveSources } = await import("./activityService.ts");
const { Diagnostics } = await import("../effect/ports/diagnostics.ts");
const { Scheduler } = await import("../effect/ports/scheduler.ts");
const { createFolder, live, removeFolder } = await import("./activityStore.ts");

const item = (source, id) => ({
  id: `${source}:${id}`,
  source,
  kind: "pullRequest",
  title: id,
  url: `https://example.com/${id}`,
  updatedAt: 1,
  section: "authored",
});

// The sources a folder asks: one that answers, one that refuses.
const fakeSources = () => {
  const lab = {
    asked: [],
    gate: null,
    failing: false,
  };

  const sources = {
    github: {
      id: "github",
      name: "GitHub",
      kind: "pullRequests",
      site: "https://github.com",
      fetch: async () => {
        lab.asked.push("github");

        if (lab.gate) await lab.gate;

        if (lab.failing) throw new Error("GitHub is down");

        return [item("github", "one")];
      },
    },
    bitbucket: {
      id: "bitbucket",
      name: "Bitbucket",
      kind: "pullRequests",
      site: "https://bitbucket.org",
      fetch: async () => {
        lab.asked.push("bitbucket");

        return [item("bitbucket", "two")];
      },
    },
  };

  const layer = Layer.succeed(LiveSources)(sources);

  return { layer, lab };
};

const withService = async (use) => {
  const sources = fakeSources();

  const runtime = ManagedRuntime.make(
    ActivityService.layer.pipe(Layer.provide(Layer.mergeAll(sources.layer, Scheduler.layer.pipe(Layer.provide(Diagnostics.layer))))),
  );

  try {
    await use({ lab: sources.lab, runtime });
  } finally {
    await runtime.dispose();
  }
};

// Waits until the sources were asked `count` times: a slow machine takes longer to get there, and a fixed wait would
// race it.
const untilAsked = async (lab, count) => {
  for (let i = 0; i < 1000 && lab.asked.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

const refresh = (runtime, folderId) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const activity = yield* ActivityService;

      yield* activity.refresh(folderId);
    }),
  );

test("a folder is refreshed once at a time: the second ask waits for the first", async () => {
  await withService(async ({ lab, runtime }) => {
    useBrowser.getState().hydrate({});

    const folderId = createFolder("default", "pullRequests", ["github", "bitbucket"]);

    lab.gate = new Promise((resolve) => {
      lab.release = resolve;
    });

    const first = refresh(runtime, folderId);

    await untilAsked(lab, 2);

    assert.deepEqual(lab.asked, ["github", "bitbucket"]);

    const second = refresh(runtime, folderId);

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(lab.asked.length, 2, "the second ask did not start a second refresh");

    lab.release();
    await Promise.all([first, second]);
    assert.equal(lab.asked.length, 2);
  });
});

test("one provider that fails cannot erase another's items", async () => {
  await withService(async ({ lab, runtime }) => {
    useBrowser.getState().hydrate({});

    const folderId = createFolder("default", "pullRequests", ["github", "bitbucket"]);

    lab.failing = true;
    await refresh(runtime, folderId);

    // The failing provider leaves its items as they were; the other's items are there.
    assert.equal(lab.asked.includes("bitbucket"), true);
    assert.equal(live().status[folderId]?.state, "error");

    lab.failing = false;
    await refresh(runtime, folderId);

    assert.equal(live().status[folderId]?.state, "idle", "the folder is up to date again");
    assert.equal(live().status[folderId]?.error, null);
    assert.equal(live().items[folderId]?.length, 2);
  });
});

test("a folder that was deleted while it refreshed writes nothing", async () => {
  await withService(async ({ lab, runtime }) => {
    useBrowser.getState().hydrate({});

    const folderId = createFolder("default", "pullRequests", ["github", "bitbucket"]);

    lab.gate = new Promise((resolve) => {
      lab.release = resolve;
    });

    const refreshing = refresh(runtime, folderId);

    // The folder goes while its request is out.
    await untilAsked(lab, 1);
    removeFolder(folderId);
    lab.release();
    await refreshing;

    assert.equal(live().folders[folderId], undefined);
    assert.equal(live().items[folderId], undefined, "the late answer was not written");
  });
});
