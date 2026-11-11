// The enrichment service (lib/enrichmentService.ts): the batched lookups, the invalidation, and what it holds.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as TestClock from "effect/testing/TestClock";

const { useBrowser } = await import("../store/browserStore.ts");
const { EnrichmentEngine, EnrichmentFailure, EnrichmentService } = await import("./enrichmentService.ts");
const { fakeDiagnostics, testClockLayer, ResourceLedger } = await import("../effect/testing.ts");
const { FAVICON_LOOKUP_DELAY_MS, PICTURE_SETTLE_MS } = await import("./constants.ts");

// The Mac, as a test wants it: what it was asked, and what it answers. A held answer waits for the test.
const fakeEngine = () => {
  const lab = {
    lookups: [],
    icons: [],
    themes: [],
    pictures: [],
    artworks: [],
    fails: false,
    held: null,
    heldArtwork: null,
    heldPicture: null,
  };

  const layer = Layer.succeed(EnrichmentEngine)({
    favicons: (profile, pages) =>
      Effect.suspend(() => {
        lab.lookups.push([profile, [...pages]]);

        if (lab.fails) {
          return Effect.fail(new EnrichmentFailure({ operation: { name: "enrichment.favicons", resource: profile }, cause: new Error("no answer") }));
        }

        if (lab.held) {
          return Effect.tryPromise({
            try: () => lab.held.promise,
            catch: (cause) => new EnrichmentFailure({ operation: { name: "enrichment.favicons", resource: profile }, cause }),
          });
        }

        return Effect.succeed(new Map(pages.map((page) => [page, `icon:${page}`])));
      }),
    icon: (tabId, src) =>
      Effect.sync(() => {
        lab.icons.push([tabId, src]);

        return `icon:${src}`;
      }),
    favicon: (url) => Effect.succeed(`icon:${url}`),
    theme: (uri) =>
      Effect.sync(() => {
        lab.themes.push(uri);

        return { kind: "blur" };
      }),
    picture: (tabId) =>
      Effect.suspend(() => {
        lab.pictures.push(tabId);

        if (!lab.heldPicture) return Effect.succeed({ data: "data:image", frame: [0, 0, 1, 1] });

        return Effect.tryPromise({
          try: () => lab.heldPicture.promise,
          catch: (cause) => new EnrichmentFailure({ operation: { name: "enrichment.picture", resource: tabId }, cause }),
        });
      }),
    artwork: (tabId, url) =>
      Effect.suspend(() => {
        lab.artworks.push([tabId, url]);

        if (!lab.heldArtwork) return Effect.succeed(`art:${url}`);

        return Effect.tryPromise({
          try: () => lab.heldArtwork.promise,
          catch: (cause) => new EnrichmentFailure({ operation: { name: "enrichment.artwork", resource: url }, cause }),
        });
      }),
  });

  return { layer, lab };
};

function deferred() {
  let resolve;

  const promise = new Promise((r) => {
    resolve = r;
  });

  return { promise, resolve };
}

// The service, with the Mac and the diagnostics a test wants.
const withService = async (use) => {
  const engine = fakeEngine();
  const diagnostics = fakeDiagnostics();

  const runtime = ManagedRuntime.make(
    EnrichmentService.layer.pipe(Layer.provide(engine.layer), Layer.provideMerge(Layer.mergeAll(diagnostics.layer, testClockLayer))),
  );

  try {
    const service = await runtime.runPromise(Effect.flatMap(EnrichmentService, (s) => Effect.succeed(s)));

    await use({ service, lab: engine.lab, diagnostics, runtime });
  } finally {
    await runtime.dispose();
  }
};

// Lets the burst run: the clock moves, and the fibers it woke get a turn to finish.
const settle = async (runtime, until, step = FAVICON_LOOKUP_DELAY_MS) => {
  for (let i = 0; i < 40; i++) {
    await runtime.runPromise(TestClock.adjust(Duration.millis(step)));
    await new Promise((resolve) => setTimeout(resolve, 0));

    if (await until()) return true;
  }

  return false;
};

const tab = (id, url = `https://site/${id}`) => {
  useBrowser.setState({ tabs: { ...useBrowser.getState().tabs, [id]: { id, url, spaceId: "work" } } });
};

test("a burst of icons is one lookup and one write", async () => {
  await withService(async ({ service, lab, runtime }) => {
    const writes = [];

    // One sink for the burst, as the cache has: the answer of a lookup is one write.
    const onAnswers = (icons) => writes.push(icons);

    for (let i = 0; i < 100; i++) {
      service.requestFavicons({
        profile: "work",
        page: `https://site/${i}`,
        onAnswers,
      });
    }

    assert.ok(await settle(runtime, () => writes.length > 0), "the icons were looked up");

    assert.equal(lab.lookups.length, 1, "a hundred icons are one lookup");
    assert.equal(lab.lookups[0][1].length, 100, "the lookup has every page of the burst");
    assert.equal(writes.length, 1, "the answer of one lookup is one write");
    assert.equal(writes[0].size, 100);
    assert.equal(lab.icons.length, 0, "no icon is fetched on its own");
  });
});

test("a page that is forgotten while its answer is on its way gets no answer", async () => {
  await withService(async ({ service, lab, runtime }) => {
    const answer = deferred();
    const writes = [];

    lab.held = answer;
    service.requestFavicons({
      profile: "work",
      page: "https://site/gone",
      onAnswers: (icons) => writes.push(icons),
    });

    assert.ok(await settle(runtime, () => lab.lookups.length > 0), "the lookup went out");

    // The page's history is deleted while the answer is on its way.
    service.forgetPage("work", "https://site/gone");
    answer.resolve(new Map([["https://site/gone", "icon:gone"]]));
    await settle(runtime, () => writes.length > 0);

    assert.deepEqual(writes, [], "the answer of a page that is gone is not written back");
  });
});

test("a profile that is forgotten takes its own answers with it, and only its own", async () => {
  await withService(async ({ service, lab, runtime }) => {
    const answer = deferred();
    const mine = [];
    const theirs = [];

    lab.held = answer;
    service.requestFavicons({
      profile: "mine",
      page: "https://site/mine",
      onAnswers: (icons) => mine.push(icons),
    });
    service.requestFavicons({
      profile: "theirs",
      page: "https://site/theirs",
      onAnswers: (icons) => theirs.push(icons),
    });

    assert.ok(await settle(runtime, () => lab.lookups.length > 0), "the first lookup went out");

    // The profile's icons are cleared while its answer is on its way.
    service.invalidateProfile("mine");
    answer.resolve(
      new Map([
        ["https://site/mine", "icon:mine"],
        ["https://site/theirs", "icon:theirs"],
      ]),
    );
    await settle(runtime, () => theirs.length > 0);

    assert.deepEqual(mine, [], "the forgotten profile's answer is not its answer any more");
    assert.equal(theirs.length, 1, "the other profile still gets its answer");
    assert.equal(theirs[0].get("https://site/theirs"), "icon:theirs");
  });
});

test("a failed lookup is reported once and is not asked again", async () => {
  await withService(async ({ service, lab, diagnostics, runtime }) => {
    const failures = [];

    lab.fails = true;
    service.requestFavicons({
      profile: "work",
      page: "https://site/a",
      onAnswers: () => {},
      onFailed: () => failures.push("failed"),
    });

    assert.ok(await settle(runtime, () => failures.length > 0), "the failure was reported to the page");

    assert.equal(diagnostics.reports.length, 1, "the failure is reported once");
    assert.equal(diagnostics.reports[0].operation.name, "enrichment.favicons");
    assert.equal(failures.length, 1, "the page is told once, so it is asked again when it is shown");

    // The service does not spin: the lookup is not made again on its own.
    await settle(runtime, () => false, FAVICON_LOOKUP_DELAY_MS * 4);

    assert.equal(lab.lookups.length, 1, "the lookup is not tried again");
    assert.equal(diagnostics.reports.length, 1, "the failure is not reported again");
  });
});

test("the artwork of a tab that was forgotten is not written back", async () => {
  await withService(async ({ service, lab, runtime }) => {
    const answer = deferred();
    const written = [];

    tab("t1");
    lab.heldArtwork = answer;
    service.requestArtwork({
      tabId: "t1",
      url: "https://site/art.png",
      onArtwork: (uri) => written.push(uri),
    });

    assert.ok(await settle(runtime, () => lab.artworks.length > 0), "the artwork was asked for");

    // The tab is gone while the artwork is on its way.
    service.forgetTab("t1");
    answer.resolve("art:https://site/art.png");
    await settle(runtime, () => written.length > 0);

    assert.deepEqual(written, [], "the artwork of a tab that is gone is not written back");
  });
});

test("the artwork of a tab that closed is not written back", async () => {
  await withService(async ({ service, lab, runtime }) => {
    const answer = deferred();
    const written = [];

    tab("t1");
    lab.heldArtwork = answer;
    service.requestArtwork({
      tabId: "t1",
      url: "https://site/art.png",
      onArtwork: (uri) => written.push(uri),
    });

    assert.ok(await settle(runtime, () => lab.artworks.length > 0), "the artwork was asked for");

    // The tab closed while the artwork was on its way.
    useBrowser.setState({ tabs: {} });
    answer.resolve("art:https://site/art.png");
    await settle(runtime, () => written.length > 0);

    assert.deepEqual(written, [], "the artwork of a closed tab is not written back");
  });
});

test("the picture of a tab the window no longer shows is not written back", async () => {
  await withService(async ({ service, lab, runtime }) => {
    const answer = deferred();
    const written = [];

    useBrowser.setState({
      windows: { w1: { id: "w1", spaceId: "work", activeTabIds: { work: "t1" } } },
      tabs: { t1: { id: "t1", url: "https://site/t1", spaceId: "work", windowId: "w1" } },
    });

    lab.heldPicture = answer;
    service.requestPicture({
      windowId: "w1",
      tabId: "t1",
      onPicture: (picture) => written.push(picture),
    });

    assert.ok(await settle(runtime, () => lab.pictures.length > 0, PICTURE_SETTLE_MS), "the picture was taken");

    // The window shows another tab now: the picture would be of a tab that is not there.
    useBrowser.setState({
      windows: { w1: { id: "w1", spaceId: "work", activeTabIds: { work: "t2" } } },
      tabs: {
        t1: { id: "t1", url: "https://site/t1", spaceId: "work", windowId: "w1" },
        t2: { id: "t2", url: "https://site/t2", spaceId: "work", windowId: "w1" },
      },
    });

    answer.resolve({ data: "data:image", frame: [0, 0, 1, 1] });
    await settle(runtime, () => written.length > 0);

    assert.deepEqual(written, [], "the picture of another tab is not written back");
  });
});

test("the service lets go of everything it held when its scope closes", async () => {
  await withService(async ({ service, runtime }) => {
    const ledger = new ResourceLedger();

    // What the service holds is what it took.
    const account = () => {
      const names = new Set(service.held());

      for (const name of names) ledger.take(name);

      for (const name of ledger.outstanding()) if (!names.has(name)) ledger.give(name);
    };

    service.requestFavicons({
      profile: "work",
      page: "https://site/a",
      onAnswers: () => {},
    });
    service.requestTheme({
      uri: "icon:a",
      onTheme: () => {},
    });

    account();
    assert.ok(ledger.outstanding().length > 0, "the service holds the work it was given");

    await runtime.dispose();
    account();

    assert.deepEqual(ledger.outstanding(), [], "the service gave everything back");
  });
});
