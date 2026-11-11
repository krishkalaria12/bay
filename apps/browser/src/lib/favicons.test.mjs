import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as TestClock from "effect/testing/TestClock";

// Execute hook effects without a renderer. The stores and queued production pipeline stay real.
const native = new URL("../test-native-stub.mjs", import.meta.url).href;
const vanilla = import.meta.resolve("zustand/vanilla");

const stubs = {
  react: "export const useEffect = (effect) => globalThis.faviconTest.cleanups.push(effect());",
  zustand: `import { createStore } from ${JSON.stringify(vanilla)};
    export const create = (init) => { const api = createStore(init); return Object.assign((select) => select(api.getState()), api); };
    export const useStore = (api) => api.getState();`,
  "@bay/chromium": `export * from ${JSON.stringify(native)};
    export const onHistoryChanged = (listener) => { globalThis.faviconTest.history = listener; return { remove() {} }; };
    export const faviconsFor = (...args) => globalThis.faviconTest.lookup(...args);`,
  "@bay/desktop": `export * from ${JSON.stringify(native)};
    export const iconTheme = (...args) => globalThis.faviconTest.theme(...args);`,
};

registerHooks({
  resolve(specifier, context, next) {
    if (!context.parentURL?.endsWith("/lib/favicons.ts") || !(specifier in stubs)) return next(specifier, context);

    return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  },
});

const { useBrowser } = await import("../store/browserStore.ts");
const { setSpaceProfiles } = await import("../store/model.ts");
const { webviews } = await import("./webviews.ts");
const { FAVICON_FLUSH_MS, FAVICON_LOOKUP_DELAY_MS, MAX_FAVICONS, APPEARANCE_SWAP_MS } = await import("./constants.ts");
const { EnrichmentEngine, EnrichmentFailure, EnrichmentService } = await import("./enrichmentService.ts");
const { fakeDiagnostics, testClockLayer } = await import("../effect/testing.ts");

const { useFavicons, noteFavicon, faviconFailed, pruneProfileFavicons, resolveFavicon, startFavicons, useFavicon, useFaviconTheme } =
  await import("./favicons.ts");

const state = () => useFavicons.getState();
const empty = () => ({ pages: {}, srcs: {}, appearances: {} });

// The Mac, as the favicons test wants it: the answers the test scripts.
const engineLayer = () =>
  Layer.succeed(EnrichmentEngine)({
    favicons: (profile, pages) =>
      Effect.tryPromise({
        try: () => globalThis.faviconTest.lookup(profile, [...pages]),
        catch: (cause) => new EnrichmentFailure({ operation: { name: "enrichment.favicons", resource: profile }, cause }),
      }).pipe(
        Effect.map((found) => {
          const answers = new Map();

          for (const page of pages) answers.set(page, found.pages.get(page)?.uri ?? null);

          return answers;
        }),
      ),
    icon: (tabId, src) =>
      Effect.suspend(() => {
        const view = webviews.get(tabId);

        if (!view) return Effect.succeed(null);

        return Effect.tryPromise({
          try: () => view.downloadFavicon(src),
          catch: (cause) => new EnrichmentFailure({ operation: { name: "enrichment.icon", resource: src }, cause }),
        }).pipe(Effect.map((image) => image?.uri ?? null));
      }),
    favicon: () => Effect.succeed(null),
    theme: (uri) =>
      Effect.tryPromise({
        try: () => globalThis.faviconTest.theme({ uri }),
        catch: (cause) => new EnrichmentFailure({ operation: { name: "enrichment.theme", resource: uri }, cause }),
      }).pipe(Effect.map((theme) => theme ?? null)),
    picture: () => Effect.succeed(null),
    artwork: () => Effect.succeed(null),
  });

// The enrichment service the cache asks: it owns the lookups, the fetches and the themes.
let enrichment;

// Moves the clock, and gives the burst that woke a turn to answer.
const advance = async (ms = FAVICON_LOOKUP_DELAY_MS) => {
  await enrichment.runPromise(TestClock.adjust(Duration.millis(ms)));
  await new Promise((resolve) => setImmediate(resolve));
};

const drain = async () => {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    await advance();
  }
};

function deferred() {
  let resolve;

  const promise = new Promise((r) => {
    resolve = r;
  });

  return { promise, resolve };
}

function setup(t, profiles = {}, themes = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  useBrowser.getState().hydrate({});
  useBrowser.setState({ ui: { ...useBrowser.getState().ui, appDark: false } });
  setSpaceProfiles({});
  webviews.clear();
  useFavicons.setState({ profiles, themes }, true);
  globalThis.faviconTest = {
    cleanups: [],
    lookup: async () => ({ pages: new Map(), icons: new Map() }),
    theme: async () => null,
  };

  const runtime = ManagedRuntime.make(
    EnrichmentService.layer.pipe(Layer.provide(engineLayer()), Layer.provideMerge(Layer.mergeAll(fakeDiagnostics().layer, testClockLayer))),
  );

  enrichment = runtime;
  const stop = startFavicons();
  t.after(async () => {
    stop();

    for (const cleanup of globalThis.faviconTest.cleanups) cleanup?.();
    await drain();
    t.mock.timers.tick(FAVICON_FLUSH_MS);
    webviews.clear();
    await runtime.dispose();
  });
}

function tab(id, url = `https://site/${id}`, spaceId = "work", download = async (src) => ({ uri: `data:${src}` })) {
  useBrowser.setState({ tabs: { ...useBrowser.getState().tabs, [id]: { id, url, spaceId } } });
  webviews.set(id, { downloadFavicon: download });
}

const flush = (t) => t.mock.timers.tick(FAVICON_FLUSH_MS);
const history = (urls, all = false, profile = "work") => globalThis.faviconTest.history({ kind: "deleted", profile, urls, all });

function freezeIcons(icons) {
  for (const map of Object.values(icons)) Object.freeze(map);

  return Object.freeze(icons);
}

test("download bursts share inflight answers and publish once, then identical reports do nothing", async (t) => {
  setup(t);
  const answer = deferred();
  let calls = 0;

  const download = () => {
    calls++;

    return answer.promise;
  };

  tab("a", "https://site/a#one", "work", download);
  tab("b", "https://site/b", "work", download);
  const before = state();
  let notifications = 0;
  t.after(useFavicons.subscribe(() => notifications++));
  noteFavicon("a", "shared");
  noteFavicon("b", "shared");
  noteFavicon("a", "shared");
  // The fetches are the enrichment service's work: they go out in one burst.
  await drain();
  assert.equal(calls, 1);
  answer.resolve({ uri: "data:shared" });
  await drain();
  assert.equal(state(), before);
  flush(t);
  assert.equal(notifications, 1);
  assert.deepEqual(state().profiles.work.pages, { "https://site/a": "data:shared", "https://site/b": "data:shared" });
  const recorded = state();
  noteFavicon("a", "shared");
  noteFavicon("b", "shared");
  flush(t);
  assert.equal(state(), recorded);
  assert.equal(notifications, 1);
});

test("a burst bounds map enumeration and never mutates published snapshots", async (t) => {
  const original = freezeIcons({ pages: { old: "data:old" }, srcs: { old: "data:old" }, appearances: {} });
  setup(t, Object.freeze({ work: original }));
  const tabs = {};

  for (let i = 0; i < 1000; i++) {
    tabs[i] = { id: String(i), spaceId: "work", url: `https://burst/${i}` };
    webviews.set(String(i), { downloadFavicon: async () => ({ uri: `data:${i}` }) });
  }

  useBrowser.setState({ tabs });

  for (let i = 0; i < 1000; i++) noteFavicon(String(i), `src:${i}`);
  await drain();
  const keys = Object.keys;
  let scanned = 0;
  Object.keys = (map) => {
    const out = keys(map);
    scanned += out.length;

    return out;
  };

  try {
    flush(t);
  } finally {
    Object.keys = keys;
  }

  assert.ok(scanned < 10_000, `enumerated ${scanned} entries for a 1000-icon burst`);
  assert.equal(keys(state().profiles.work.pages).length, 1001);
  assert.equal(keys(state().profiles.work.srcs).length, 1001);
  assert.equal(state().profiles.work.appearances, original.appearances);
  assert.deepEqual(original.pages, { old: "data:old" });
  const first = freezeIcons(state().profiles.work);
  tab("next");
  noteFavicon("next", "next");
  await drain();
  flush(t);
  assert.equal(first.pages["https://site/next"], undefined);
});

test("reports, history deletes, failures and immediate clears retain queue order", async (t) => {
  setup(t);
  tab("a");
  tab("b");
  noteFavicon("a", "a");
  await drain();
  history(["https://site/a#fragment"]);
  noteFavicon("b", "b");
  await drain();
  flush(t);
  assert.deepEqual(state().profiles.work.pages, { "https://site/b": "data:b" });
  assert.equal(state().profiles.work.srcs.a, "data:a", "history deletion keeps source cache behavior");
  noteFavicon("a", "a");
  faviconFailed("work", "data:a");
  noteFavicon("b", "b");
  pruneProfileFavicons("work");
  assert.deepEqual(state().profiles.work, empty(), "clear applies after queued work, immediately");
  noteFavicon("a", "a");
  await drain();
  history([], true);
  assert.deepEqual(state().profiles.work, empty());
  noteFavicon("a", "a");
  await drain();
  faviconFailed("work", "data:a");
  flush(t);
  assert.equal(state().profiles.work.pages["https://site/a"], null);
  assert.equal(state().profiles.work.srcs.a, undefined);
  const before = state();
  history(["https://absent/"]);
  faviconFailed("work", "data:absent");
  flush(t);
  assert.equal(state(), before);
});

test("a report after a queued delete restores the page, and a late download after clear still lands", async (t) => {
  setup(t, { work: { pages: { "https://site/a": "data:a" }, srcs: { a: "data:a" }, appearances: {} } });
  tab("a");
  history(["https://site/a"]);
  noteFavicon("a", "a");
  flush(t);
  assert.equal(state().profiles.work.pages["https://site/a"], "data:a");
  const late = deferred();
  tab("late", "https://site/late", "work", () => late.promise);
  noteFavicon("late", "late");
  pruneProfileFavicons("work");
  late.resolve({ uri: "data:late" });
  await drain();
  flush(t);
  assert.deepEqual(state().profiles.work.pages, { "https://site/late": "data:late" });
});

test("page and source caps reset at the same write, including replacement at capacity", async (t) => {
  const pages = {},
    srcs = {};

  for (let i = 0; i < MAX_FAVICONS - 1; i++) {
    pages[`old:${i}`] = `data:${i}`;
    srcs[`old:${i}`] = `data:${i}`;
  }

  setup(t, { work: freezeIcons({ pages, srcs, appearances: {} }) });
  tab("a");
  tab("b");
  tab("c");

  for (const id of ["a", "b", "c"]) noteFavicon(id, id);
  await drain();
  flush(t);
  assert.deepEqual(state().profiles.work.pages, { "https://site/b": "data:b", "https://site/c": "data:c" });
  assert.deepEqual(state().profiles.work.srcs, { b: "data:b", c: "data:c" });
  useFavicons.setState({
    profiles: { work: freezeIcons({ pages: { ...pages, "https://site/a": "data:a" }, srcs: { ...srcs, a: "data:a" }, appearances: {} }) },
  });
  const before = state();
  noteFavicon("a", "a");
  flush(t);
  assert.equal(state(), before, "identical answers at capacity never reset");
  noteFavicon("a", "replacement");
  await drain();
  flush(t);
  assert.deepEqual(state().profiles.work.pages, { "https://site/a": "data:replacement" });
  assert.deepEqual(state().profiles.work.srcs, { replacement: "data:replacement" });
});

test("appearance pairs capture enqueue-time dark mode and survive cap resets", async (t) => {
  const original = freezeIcons({ pages: { "https://site/a": "light" }, srcs: { light: "light" }, appearances: {} });
  setup(t, { work: original });
  tab("a");
  useBrowser.setState({ ui: { ...useBrowser.getState().ui, appDark: true } });
  noteFavicon("a", "dark");
  await drain();
  useBrowser.setState({ ui: { ...useBrowser.getState().ui, appDark: false } });
  flush(t);
  assert.deepEqual(state().profiles.work.appearances["https://site/a"], ["light", "data:dark"]);
  assert.equal(resolveFavicon("https://site/a", null, "work").uri, "light");
  useBrowser.setState({ ui: { ...useBrowser.getState().ui, appDark: true } });
  assert.equal(resolveFavicon("https://site/a", null, "work").uri, "data:dark");
  const pair = state().profiles.work.appearances;
  t.mock.timers.tick(APPEARANCE_SWAP_MS + 1);
  noteFavicon("a", "later");
  await drain();
  flush(t);
  assert.equal(state().profiles.work.appearances, pair);
  const pages = Object.fromEntries(Array.from({ length: MAX_FAVICONS }, (_, i) => [`old:${i}`, "old"]));
  useFavicons.setState({ profiles: { work: { ...state().profiles.work, pages } } });
  noteFavicon("a", "reset");
  await drain();
  flush(t);
  assert.equal(state().profiles.work.appearances, pair);
  assert.deepEqual(original.appearances, {});
});

test("theme answers coalesce with icons, preserve both branches and retain cap resets", async (t) => {
  const themes = Object.fromEntries(Array.from({ length: MAX_FAVICONS - 1 }, (_, i) => [`old:${i}`, null]));
  setup(
    t,
    { work: { pages: { "https://site/a": "uri:a", "https://site/b": "uri:b", "https://site/c": "uri:c" }, srcs: {}, appearances: {} } },
    Object.freeze(themes),
  );
  const answers = new Map();
  globalThis.faviconTest.theme = ({ uri }) => {
    const answer = deferred();
    answers.set(uri, answer);

    return answer.promise;
  };

  for (const id of ["a", "b", "c"]) useFaviconTheme(`https://site/${id}`, null, "work");
  tab("next");
  const before = state();
  // The theme analysis is the enrichment service's work: it goes out in one burst.
  await drain();
  answers.get("uri:a").resolve({ color: "red" });
  await drain();
  noteFavicon("next", "next");
  await drain();
  answers.get("uri:b").resolve(null);
  await drain();
  answers.get("uri:c").resolve({ color: "blue" });
  await drain();
  assert.equal(state(), before);
  flush(t);
  assert.deepEqual(state().themes, { "uri:b": null, "uri:c": { color: "blue" } });
  assert.equal(state().profiles.work.pages["https://site/next"], "data:next");
  assert.equal(Object.keys(themes).length, MAX_FAVICONS - 1);
});

test("private-window cleanup flushes reports and only removes closed private profiles", async (t) => {
  setup(t);
  tab("public");
  tab("private", "https://private/", "incognito:closed");
  noteFavicon("public", "public");
  noteFavicon("private", "private");
  await drain();
  useBrowser.setState({ tabs: { public: useBrowser.getState().tabs.public }, windows: {} });
  assert.equal(state().profiles["incognito:closed"], undefined);
  assert.equal(state().profiles.work.pages["https://site/public"], "data:public");
  tab("kept", "https://kept/", "incognito:kept");
  noteFavicon("kept", "kept");
  await drain();
  useBrowser.setState({ windows: {} });
  assert.equal(state().profiles["incognito:kept"].pages["https://kept/"], "data:kept");
});

test("reentrant subscribers can immediately clear or queue without mutating outer snapshots", (t) => {
  setup(t, { work: { pages: {}, srcs: { a: "data:a", b: "data:b" }, appearances: {} } });
  tab("a");
  tab("b");
  const snapshots = [];

  const stop = useFavicons.subscribe((f) => {
    snapshots.push(f);
    freezeIcons(f.profiles.work);
    Object.freeze(f.profiles);

    if (snapshots.length === 1) {
      noteFavicon("b", "b");
      pruneProfileFavicons("work");
    }
  });

  noteFavicon("a", "a");
  flush(t);
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots[0].profiles.work.pages, { "https://site/a": "data:a" });
  assert.deepEqual(state().profiles.work, empty());
  stop();
  useFavicons.setState({ profiles: { work: { pages: {}, srcs: { a: "data:a", b: "data:b" }, appearances: {} } } });
  let count = 0;
  t.after(
    useFavicons.subscribe(() => {
      if (++count === 1) noteFavicon("b", "b");
    }),
  );
  noteFavicon("a", "a");
  flush(t);
  assert.equal(count, 1);
  assert.deepEqual(state().profiles.work.pages, { "https://site/a": "data:a" });
  flush(t);
  assert.equal(count, 2);
  assert.deepEqual(state().profiles.work.pages, { "https://site/a": "data:a", "https://site/b": "data:b" });
});

test("native lookup answers flush after pending reports and capped resets notify missing-page watchers", async (t) => {
  setup(t);

  const lookup = deferred(),
    calls = [];

  globalThis.faviconTest.lookup = (key, pages) => {
    calls.push([key, pages]);

    return lookup.promise;
  };

  useFavicon("https://missing/", null, "work");
  await advance();
  assert.deepEqual(calls, [["work", ["https://missing/"]]]);
  tab("a");
  noteFavicon("a", "a");
  await drain();
  lookup.resolve({ pages: new Map([["https://missing/", { uri: "native" }]]) });
  await drain();
  // The report of the tab landed after the lookup's answer, so it waits for the next flush.
  flush(t);
  assert.equal(state().profiles.work.pages["https://site/a"], "data:a");
  assert.equal(state().profiles.work.pages["https://missing/"], "native");
  useFavicons.setState({ profiles: { work: { ...state().profiles.work, pages: { ...state().profiles.work.pages, "https://none/": null } } } });
  useFavicon("https://none/", null, "work");
  const full = { ...state().profiles.work.pages };

  for (let i = Object.keys(full).length; i < MAX_FAVICONS; i++) full[`old:${i}`] = "old";
  useFavicons.setState({ profiles: { work: { ...state().profiles.work, pages: full } } });
  tab("reset");
  noteFavicon("reset", "reset");
  await drain();
  flush(t);
  assert.equal(state().profiles.work.pages["https://missing/"], undefined);
  await advance();
  assert.deepEqual(calls[1], ["work", ["https://none/"]], "reset checks watchers on pages other than the newly recorded page");
  pruneProfileFavicons("work");
  useFavicon("https://missing/", null, "work");
  await advance();
  assert.equal(calls.length, 3);
});

test("shared engine profiles coalesce while other profiles and their published maps remain independent", async (t) => {
  const kept = freezeIcons({ pages: { "https://kept/": "kept" }, srcs: {}, appearances: {} });
  setup(t, { kept });
  setSpaceProfiles({ personal: "shared", work: "shared" });
  tab("a", "https://site/a", "personal");
  tab("b", "https://site/b", "work");
  tab("c", "https://site/c", "other");
  noteFavicon("a", "a");
  noteFavicon("b", "b");
  noteFavicon("c", "c");
  await drain();
  flush(t);
  assert.deepEqual(state().profiles.shared.pages, { "https://site/a": "data:a", "https://site/b": "data:b" });
  assert.deepEqual(state().profiles.other.pages, { "https://site/c": "data:c" });
  assert.equal(state().profiles.kept, kept);
  assert.equal(resolveFavicon("https://site/a", null, "work").uri, "data:a");
});

test("capacity counts ignore replacement keys and a known source keeps its full cache", async (t) => {
  const srcs = Object.fromEntries(Array.from({ length: MAX_FAVICONS }, (_, i) => [`src:${i}`, `data:${i}`]));
  setup(t, { work: freezeIcons({ pages: {}, srcs, appearances: {} }) });
  tab("a");
  noteFavicon("a", "src:0");
  flush(t);
  assert.equal(state().profiles.work.srcs, srcs);
  assert.equal(state().profiles.work.pages["https://site/a"], "data:0");

  // Replacing a page repeatedly must not count each report as an additional key.
  for (let i = 1; i < MAX_FAVICONS; i++) noteFavicon("a", `src:${i}`);
  flush(t);
  assert.deepEqual(state().profiles.work.pages, { "https://site/a": `data:${MAX_FAVICONS - 1}` });
  assert.equal(state().profiles.work.srcs, srcs);
});
