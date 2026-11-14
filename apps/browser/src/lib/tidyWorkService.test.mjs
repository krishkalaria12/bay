import { AuthorityStore } from "../effect/ports/store.ts";
// The tidy work (lib/tidyWorkService.ts): what a run applies, and what it leaves alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as TestClock from "effect/testing/TestClock";

const { useBrowser } = await import("../store/browserStore.ts");
const { testClockLayer } = await import("../effect/testing.ts");
const { TidyEngine, TidyFailure, TidyWorkService } = await import("./tidyWorkService.ts");

const S = () => useBrowser.getState();
const groupOfTab = (id) => Object.values(S().groups).find((g) => g.tabIds.includes(id));

// The Mac's model, as a test wants it: what it answers, and what it was asked.
const fakeEngine = () => {
  const lab = {
    status: "available",
    answer: null,
    statuses: 0,
    prompts: [],
  };

  const layer = Layer.succeed(TidyEngine)({
    status: () =>
      Effect.sync(() => {
        lab.statuses++;

        return lab.status;
      }),
    group: (prompt) =>
      Effect.tryPromise({
        try: async () => {
          lab.prompts.push(prompt);

          return lab.answer ? lab.answer(prompt) : null;
        },
        catch: (cause) => new TidyFailure({ operation: { name: "tidy.group" }, cause }),
      }),
  });

  return { layer, lab };
};

const withWork = async (use) => {
  const engine = fakeEngine();

  const runtime = ManagedRuntime.make(
    Layer.mergeAll(TidyWorkService.layer.pipe(Layer.provide(AuthorityStore.layer(useBrowser)), Layer.provide(engine.layer)), testClockLayer),
  );

  try {
    await use({ lab: engine.lab, runtime });
  } finally {
    await runtime.dispose();
  }
};

const tidy = (runtime, windowId, minimumRunMs = 0) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const work = yield* TidyWorkService;

      return yield* work.run({ windowId, minimumRunMs });
    }),
  );

// The run waits on the test's clock, so the clock is what moves it along.
const settle = async (runtime, running) => {
  let settled = false;

  running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  for (let i = 0; i < 40 && !settled; i++) {
    await runtime.runPromise(TestClock.adjust(100));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return settled;
};

const SITES = ["https://nasa.gov/nasa", "https://wikipedia.org/saturn", "https://nasa.gov/jupiter", "https://booking.com/lisbon", "https://example.com/x"];

function setup(urls = SITES) {
  S().hydrate({});
  const w = S().createWindow({ url: urls[0] });
  const ids = [S().windows[w].activeTabIds[S().windows[w].spaceId], ...urls.slice(1).map((url) => S().newTab(w, { url, background: true }))];

  return { w, ids };
}

// The ids the prompt gave the tabs, so the answer can name them.
const idsMatching = (prompt, pattern) =>
  prompt
    .split("\n")
    .filter((line) => pattern.test(line))
    .map((line) => Number.parseInt(line, 10));

test("the model's groups are applied", async () => {
  await withWork(async ({ lab, runtime }) => {
    const { w, ids } = setup();

    lab.answer = (prompt) => [{ name: "Planets", tabs: idsMatching(prompt, /nasa/) }];

    const outcome = await tidy(runtime, w);

    assert.equal(outcome.kind, "tidied");
    assert.equal(outcome.source, "model");
    assert.equal(outcome.groups, 1);
    assert.equal(outcome.moved, 2, "the two tabs of the group moved into it");
    assert.equal(groupOfTab(ids[0]).name, "Planets");
    assert.deepEqual([...groupOfTab(ids[0]).tabIds].sort(), [ids[0], ids[2]].sort());
  });
});

test("a model that cannot answer groups the tabs by their site", async () => {
  await withWork(async ({ lab, runtime }) => {
    const { w, ids } = setup();

    lab.status = "off";

    const outcome = await tidy(runtime, w);

    assert.equal(lab.prompts.length, 0, "a model that cannot answer is not asked");
    assert.equal(outcome.source, "site");
    assert.deepEqual([...groupOfTab(ids[0]).tabIds].sort(), [ids[0], ids[2]].sort(), "the tabs of one site are grouped together");
  });
});

test("a window that closes while the model thinks invalidates the plan", async () => {
  await withWork(async ({ lab, runtime }) => {
    const { w, ids } = setup();

    lab.answer = () => {
      S().closeWindow(w);

      return [{ name: "Planets", tabs: [0, 1] }];
    };

    const outcome = await tidy(runtime, w);

    assert.equal(outcome.kind, "gone");
    assert.equal(groupOfTab(ids[0]), undefined, "a closed window is left alone");
  });
});

test("a space that changes while the model thinks leaves the plan behind", async () => {
  await withWork(async ({ lab, runtime }) => {
    const { w, ids } = setup();
    const spaceId = S().createSpace({ name: "Work" });

    lab.answer = () => {
      S().switchSpace(w, spaceId);

      return [{ name: "Planets", tabs: [0, 1] }];
    };

    const outcome = await tidy(runtime, w);

    assert.equal(outcome.kind, "gone");
    assert.equal(groupOfTab(ids[0]), undefined, "the tabs of the space the run started in are left alone");
  });
});

test("a plan whose tabs changed is not applied", async () => {
  await withWork(async ({ lab, runtime }) => {
    const { w, ids } = setup();

    lab.answer = () => {
      // The person opened a tab while the model thought.
      S().newTab(w, { url: "https://example.org/new", background: true });

      return [{ name: "Planets", tabs: [0, 1] }];
    };

    const outcome = await tidy(runtime, w);

    assert.equal(outcome.kind, "tidied");
    assert.equal(outcome.source, "site", "the model's plan was made for other tabs");
    assert.ok(!Object.values(S().groups).some((g) => g.name === "Planets"), "the model's group is not made");
    assert.ok(groupOfTab(ids[0]), "the tabs are grouped by their site instead");
  });
});

test("the model's availability is asked once, and the model once", async () => {
  await withWork(async ({ lab, runtime }) => {
    const { w } = setup();

    lab.answer = (prompt) => [{ name: "Planets", tabs: idsMatching(prompt, /nasa/) }];

    await tidy(runtime, w);

    assert.equal(lab.statuses, 1);
    assert.equal(lab.prompts.length, 1);
  });
});

test("a model that is not there is not asked at all", async () => {
  await withWork(async ({ lab, runtime }) => {
    const { w, ids } = setup();

    lab.status = "off";

    const outcome = await tidy(runtime, w);

    assert.equal(lab.statuses, 1);
    assert.equal(lab.prompts.length, 0, "a model that cannot answer is not asked");
    assert.equal(outcome.source, "site");
    assert.ok(groupOfTab(ids[0]), "the tabs are grouped by their site instead");
  });
});

test("a model that fails is not asked again", async () => {
  await withWork(async ({ lab, runtime }) => {
    const { w, ids } = setup();

    lab.answer = () => {
      throw new Error("busy");
    };

    const outcome = await tidy(runtime, w);

    assert.equal(lab.prompts.length, 1, "the failure is not retried");
    assert.equal(outcome.source, "site");
    assert.ok(groupOfTab(ids[0]), "the tabs are grouped by their site instead");
  });
});

test("a run that failed lets the space go", async () => {
  await withWork(async ({ lab, runtime }) => {
    const { w } = setup();

    lab.answer = () => {
      throw new Error("busy");
    };

    await tidy(runtime, w);

    const again = await tidy(runtime, w);

    assert.notEqual(again.kind, "busy", "a run that failed does not keep the space");
  });
});

test("a private window's tabs never reach the model", async () => {
  await withWork(async ({ lab, runtime }) => {
    S().hydrate({});
    const w = S().createWindow({ url: SITES[0], incognito: true });

    S().newTab(w, { url: SITES[2], background: true });

    const outcome = await tidy(runtime, w);

    assert.equal(lab.statuses, 0, "the model's availability isn't asked either");
    assert.equal(lab.prompts.length, 0);
    assert.equal(outcome.source, "site");
  });
});

test("the wave runs at least as long as it was asked for", async () => {
  await withWork(async ({ lab, runtime }) => {
    const { w } = setup();

    lab.answer = () => [{ name: "Planets", tabs: [0, 1] }];

    let done = false;

    const running = tidy(runtime, w, 900).then((outcome) => {
      done = true;

      return outcome;
    });

    // The model has answered, and the run is still waiting for the wave.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(done, false, "a quick answer doesn't flash");

    await settle(runtime, running);

    const outcome = await running;

    assert.equal(outcome.kind, "tidied");
  });
});

test("a space being tidied is not asked twice", async () => {
  await withWork(async ({ lab, runtime }) => {
    const { w } = setup();

    let asked;
    let release;

    const holding = new Promise((resolve) => {
      release = resolve;
    });

    const askedNow = new Promise((resolve) => {
      asked = resolve;
    });

    lab.answer = async () => {
      asked();
      await holding;

      return [{ name: "Planets", tabs: [0, 1] }];
    };

    const first = tidy(runtime, w);

    await askedNow;

    const second = await tidy(runtime, w);

    assert.equal(second.kind, "busy");

    release();
    await first;

    assert.equal(lab.prompts.length, 1, "the model is asked once");
  });
});

test("a run that is interrupted lets the space go", async () => {
  await withWork(async ({ lab, runtime }) => {
    const { w } = setup();

    let asked;
    let release;

    const holding = new Promise((resolve) => {
      release = resolve;
    });

    const askedNow = new Promise((resolve) => {
      asked = resolve;
    });

    lab.answer = async () => {
      asked();
      await holding;

      return [{ name: "Planets", tabs: [0, 1] }];
    };

    const fiber = await runtime.runPromise(
      Effect.gen(function* () {
        const work = yield* TidyWorkService;

        return yield* Effect.forkDetach(work.run({ windowId: w, minimumRunMs: 0 }));
      }),
    );

    await askedNow;

    await runtime.runPromise(Fiber.interrupt(fiber));
    release();

    const again = await tidy(runtime, w);

    assert.notEqual(again.kind, "busy", "an interrupted run does not keep the space");
  });
});

test("the groups it made can be undone", async () => {
  await withWork(async ({ lab, runtime }) => {
    const { w, ids } = setup();

    lab.answer = (prompt) => [{ name: "Planets", tabs: idsMatching(prompt, /nasa/) }];

    const outcome = await tidy(runtime, w);

    assert.equal(outcome.kind, "tidied");
    assert.equal(groupOfTab(ids[0]).name, "Planets");

    S().undoSidebarEdit(w);

    assert.equal(groupOfTab(ids[0]), undefined, "the undo puts the tabs back");
  });
});
