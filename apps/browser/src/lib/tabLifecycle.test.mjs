// Sleeping background tabs (lib/tabLifecycle.ts): a tab with unsaved input never sleeps.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

globalThis.__DEV__ = false;

// The internal pages pull in the whole UI: a stand-in for them, and for the engine's task and system calls.
const nncore = new URL("../test-native-stub.mjs", import.meta.url).href;

const stubs = {
  "@bay/chromium": `export * from ${JSON.stringify(nncore)};
    export const listTasks = async () => [];
    export const onSystemState = () => ({ remove() {} });
    export const systemState = async () => ({ memoryPressure: "normal", physicalMemory: 8 * 2 ** 30, onBattery: false, lowPowerMode: false });
    export const releaseProfile = async () => {};`,
  "../components/pages/index": "export const isInternalTab = (t) => !/^https?:/.test(t.url ?? '');",
};

registerHooks({
  resolve(specifier, context, next) {
    if (!context.parentURL?.endsWith("/lib/tabLifecycle.ts") || !(specifier in stubs)) return next(specifier, context);

    return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  },
});

const { useBrowser } = await import("../store/browserStore.ts");
const { webviews } = await import("./webviews.ts");
const lifecycle = await import("./tabLifecycle.ts");

const S = () => useBrowser.getState();

// A page in a tab: evaluate answers whether it has unsaved input.
function fakePage() {
  const page = { dirty: false, evaluated: 0, discarded: 0 };
  page.handle = {
    evaluate: async () => (page.evaluated++, page.dirty),
    discard: async () => (page.discarded++, "discarded"),
  };

  return page;
}

test("a tab without unsaved input sleeps", async () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com" });
  const b = S().newTab(w, { url: "https://b.com", background: true });
  const page = fakePage();
  webviews.set(b, page.handle);
  assert.equal(await lifecycle.sleepTab(b), true);
  assert.equal(page.discarded, 1);
  webviews.delete(b);
});

test("a site added while the automatic sleep check is pending stays awake", async () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com" });
  const b = S().newTab(w, { url: "https://new.example.com", background: true });
  const page = fakePage();
  let answer;
  page.handle.evaluate = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  webviews.set(b, page.handle);

  try {
    const sleeping = lifecycle.sleepTab(b, true);
    S().updateSettings({ awakeSites: [...S().settings.awakeSites, "example.com"] });
    answer(false);
    assert.equal(await sleeping, false);
    assert.equal(page.discarded, 0);
  } finally {
    webviews.delete(b);
  }
});

test("awake sites survive two idle hours and sleep last only under critical memory pressure", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now });
  globalThis.__DEV__ = true;
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com" });
  const awake = S().newTab(w, { url: "https://web.whatsapp.com", background: true });
  const normal = S().newTab(w, { url: "https://example.com", background: true });
  const pinned = S().newTab(w, { url: "https://pinned.com", background: true });
  const row = S().newTab(w, { url: "https://row.com", background: true });
  const folder = S().newTab(w, { url: "https://folder.com", background: true });
  const grouped = S().newTab(w, { url: "https://grouped.com", background: true });
  const otherSpace = S().createSpace({ name: "Other" });
  const inactive = S().newTab(w, { url: "https://inactive.com", spaceId: otherSpace, background: true });
  S().updateTab(pinned, { pinned: true });
  S().pinRows([row], true);
  S().newPinnedFolder(w, { name: "Pinned", tabIds: [folder] });
  S().updateGroup(S().createGroup([grouped]), { pinned: true });
  const pages = new Map([awake, normal, pinned, row, folder, grouped, inactive].map((id) => [id, fakePage()]));

  const load = (id, page) => {
    page.handle.discard = async () => {
      page.discarded++;
      lifecycle.noteDiscarded(id);

      return "discarded";
    };

    webviews.set(id, page.handle);
  };

  for (const [id, page] of pages) load(id, page);
  lifecycle.startTabLifecycle();
  await new Promise((resolve) => setImmediate(resolve));
  // The largest Macs' timer (smaller ones': below).
  globalThis.nnLifecycle.simulate({ physicalMemory: 32 * 2 ** 30 });

  try {
    assert.equal(lifecycle.POLICY.idleMs, 2 * 60 * 60_000);
    assert.equal(lifecycle.POLICY.profileIdleMs, lifecycle.POLICY.idleMs);
    assert.deepEqual(await lifecycle.sweep({ protectedRecent: 0 }), []);
    t.mock.timers.setTime(now + 10 * 60_000);
    assert.deepEqual(await lifecycle.sweep({ protectedRecent: 0 }), [], "inactive spaces use the longer timer too");
    t.mock.timers.setTime(now + 119 * 60_000);
    assert.deepEqual(await lifecycle.sweep({ protectedRecent: 0 }), []);
    t.mock.timers.setTime(now + 2 * 60 * 60_000);
    assert.deepEqual(await lifecycle.sweep({ protectedRecent: 0 }), [normal, inactive]);
    assert.equal(pages.get(awake).discarded, 0);
    globalThis.nnLifecycle.simulate({ memoryPressure: "warning" });
    assert.deepEqual(await lifecycle.sweep({ protectedRecent: 0, perSweep: 10 }), []);
    assert.equal(pages.get(awake).discarded, 0);
    const urgent = S().newTab(w, { url: "https://another.com", background: true });
    pages.set(urgent, fakePage());
    load(urgent, pages.get(urgent));
    globalThis.nnLifecycle.simulate({ memoryPressure: "critical" });
    assert.deepEqual(await lifecycle.sweep({ protectedRecent: 0, perSweep: 1 }), [urgent]);
    assert.equal(pages.get(awake).discarded, 0, "ordinary tabs take the first sweep's budget");
    assert.deepEqual(await lifecycle.sweep({ protectedRecent: 0, perSweep: 1 }), [awake]);

    for (const id of [pinned, row, folder, grouped]) {
      assert.equal(pages.get(id).discarded, 0, `${S().tabs[id].url} stays pinned under critical pressure`);
    }

    // The explicit tab-menu command still honors a user's request to sleep a protected site.
    lifecycle.noteReady(awake);
    globalThis.nnLifecycle.simulate(null);
    assert.equal(await lifecycle.sleepTab(awake), true);
  } finally {
    globalThis.nnLifecycle.simulate(null);
    globalThis.__DEV__ = false;

    for (const id of pages.keys()) webviews.delete(id);
  }
});

test("warning pressure can reclaim a small recent session while keeping active, busy and unsaved pages", async () => {
  globalThis.__DEV__ = true;
  lifecycle.startTabLifecycle();
  await new Promise((resolve) => setImmediate(resolve));
  S().hydrate({});
  const w = S().createWindow({ url: "https://active.example" });
  const active = S().windows[w].activeTabIds.default;
  const ids = [active];

  for (const name of ["recent", "idle", "audio", "unsaved", "pinned", "loading"]) ids.push(S().newTab(w, { url: `https://${name}.example`, background: true }));
  const [shown, recent, idle, audio, unsaved, pinned, loading] = ids;
  ids.forEach((id, i) => S().updateTab(id, { lastActiveAt: Date.now() - i * 1000 }));
  S().updateLive(audio, { playingAudio: true });
  S().updateLive(loading, { isLoading: true });
  S().pinRows([pinned], true);
  const pages = new Map(ids.map((id) => [id, fakePage()]));
  pages.get(unsaved).dirty = true;

  for (const [id, page] of pages) {
    page.handle.discard = async () => {
      page.discarded++;
      lifecycle.noteDiscarded(id);

      return "discarded";
    };

    webviews.set(id, page.handle);
    lifecycle.noteReady(id);
  }

  try {
    globalThis.nnLifecycle.simulate({ memoryPressure: "normal" });
    assert.deepEqual(await lifecycle.sweep(), [], "the ordinary idle policy stays unchanged");
    globalThis.nnLifecycle.simulate({ memoryPressure: "warning" });
    assert.deepEqual(await lifecycle.sweep(), [idle], "warning pressure must not reserve the entire recent session");

    for (const id of [shown, recent, audio, unsaved, pinned, loading]) assert.equal(pages.get(id).discarded, 0);
    assert.equal(pages.get(unsaved).evaluated, 1, "a candidate still checks unsaved input before discarding");
  } finally {
    globalThis.nnLifecycle.simulate(null);
    globalThis.__DEV__ = false;

    for (const id of ids) {
      webviews.delete(id);
      lifecycle.noteGone(id);
    }
  }
});

test("pending startup preloads stop when memory or power conditions worsen", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.__DEV__ = true;
  lifecycle.startTabLifecycle();
  await new Promise((resolve) => setImmediate(resolve));
  globalThis.__DEV__ = false;
  const sys = { memoryPressure: "normal", physicalMemory: 8 * 2 ** 30, onBattery: false, lowPowerMode: false };
  S().hydrate({});
  const w = S().createWindow({ url: "https://shown.example" });
  const id = S().newTab(w, { url: "https://preload.example", background: true });
  S().updateTab(id, { navigation: null });

  try {
    for (const patch of [{ memoryPressure: "warning" }, { memoryPressure: "critical" }, { onBattery: true }, { lowPowerMode: true }]) {
      globalThis.nnLifecycle.simulate(sys);
      assert.deepEqual(lifecycle.reloadRecentTabs(sys), [id]);
      globalThis.nnLifecycle.simulate(patch);
      t.mock.timers.tick(2000);
      assert.equal(S().tabs[id].navigation, null);
    }

    globalThis.nnLifecycle.simulate(sys);
    assert.deepEqual(lifecycle.reloadRecentTabs(sys), [id]);
    t.mock.timers.tick(2000);
    assert.ok(S().tabs[id].navigation, "normal conditions still allow the preload");
  } finally {
    globalThis.nnLifecycle.simulate(null);
  }
});

test("smaller Macs sleep background tabs sooner and keep fewer recent ones awake", async (t) => {
  assert.deepEqual(lifecycle.policyFor(8 * 2 ** 30), { idleMs: 30 * 60_000, protectedRecent: 5 });
  assert.deepEqual(lifecycle.policyFor(16 * 2 ** 30), { idleMs: 60 * 60_000, protectedRecent: 8 });
  assert.deepEqual(lifecycle.policyFor(32 * 2 ** 30), { idleMs: lifecycle.POLICY.idleMs, protectedRecent: lifecycle.POLICY.protectedRecent });
  assert.deepEqual(lifecycle.policyFor(undefined), lifecycle.policyFor(64 * 2 ** 30), "an unknown Mac keeps the default");

  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now });
  globalThis.__DEV__ = true;
  S().hydrate({});
  const w = S().createWindow({ url: "https://shown.example" });
  // Seven background tabs, the oldest first: with the shown one, the five most recent stay awake.
  const ids = Array.from({ length: 7 }, (_, i) => S().newTab(w, { url: `https://t${i}.example`, background: true }));
  ids.forEach((id, i) => S().updateTab(id, { lastActiveAt: now - (10 - i) * 1000 }));
  S().updateTab(S().windows[w].activeTabIds.default, { lastActiveAt: now });
  const pages = new Map(ids.map((id) => [id, fakePage()]));

  for (const [id, page] of pages) {
    page.handle.discard = async () => {
      page.discarded++;
      lifecycle.noteDiscarded(id);

      return "discarded";
    };

    webviews.set(id, page.handle);
    lifecycle.noteReady(id);
  }

  lifecycle.startTabLifecycle();
  await new Promise((resolve) => setImmediate(resolve));
  // A window change notes when each loaded background page was hidden.
  S().toggleSidebar(w);
  globalThis.nnLifecycle.simulate({ physicalMemory: 8 * 2 ** 30 });

  try {
    t.mock.timers.setTime(now + 29 * 60_000);
    assert.deepEqual(await lifecycle.sweep({ perSweep: 10 }), [], "not before half an hour");
    t.mock.timers.setTime(now + 30 * 60_000);
    assert.deepEqual(new Set(await lifecycle.sweep({ perSweep: 10 })), new Set(ids.slice(0, 3)), "all but the five most recent");
    globalThis.nnLifecycle.simulate({ physicalMemory: 32 * 2 ** 30 });
    assert.deepEqual(await lifecycle.sweep({ perSweep: 10 }), [], "a larger Mac waits its two hours");
  } finally {
    globalThis.nnLifecycle.simulate(null);
    globalThis.__DEV__ = false;

    for (const id of ids) {
      webviews.delete(id);
      lifecycle.noteGone(id);
    }
  }
});
