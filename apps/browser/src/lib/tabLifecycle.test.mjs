// Sleeping and freezing background tabs (lib/tabLifecycle.ts): a tab with unsaved input never sleeps.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

globalThis.__DEV__ = false;

// The battery saver's toast and Settings, and the internal pages, pull in the whole UI: stand-ins for them, and for the
// engine's task and system calls.
const nncore = new URL("../test-native-stub.mjs", import.meta.url).href;
const stubs = {
  "@bay/nncore": `export * from ${JSON.stringify(nncore)};
    export const listTasks = async () => [];
    export const onSystemState = () => ({ remove() {} });
    export const systemState = async () => ({ memoryPressure: "normal", physicalMemory: 8 * 2 ** 30, onBattery: false, lowPowerMode: false });
    export const releaseProfile = async () => {};`,
  "../components/layout/splitActions": "export const showToast = () => {};",
  "../components/settings/windows": "export const openSettings = () => {};",
  "../components/pages": "export const isInternalTab = (t) => !/^https?:/.test(t.url ?? '');",
};
registerHooks({
  resolve(specifier, context, next) {
    if (!context.parentURL?.endsWith("/lib/tabLifecycle.ts") || !(specifier in stubs)) return next(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  },
});

const { useBrowser } = await import("../store/browser.ts");
const { webviews } = await import("./webviews.ts");
const lifecycle = await import("./tabLifecycle.ts");

const S = () => useBrowser.getState();

// A page in a tab: evaluate answers whether it has unsaved input, setFrozen resolves when the test says so.
function fakePage() {
  const page = { dirty: false, evaluated: 0, discarded: 0, release: () => {} };
  page.handle = {
    evaluate: async () => (page.evaluated++, page.dirty),
    setFrozen: () => new Promise((resolve) => (page.release = resolve)),
    discard: async () => (page.discarded++, "discarded"),
  };
  return page;
}

test("a tab shown and typed in while it was being frozen doesn't sleep", async () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com" });
  const a = S().windows[w].activeTabIds[S().windows[w].spaceId];
  const b = S().newTab(w, { url: "https://b.com", background: true });
  const page = fakePage();
  webviews.set(b, page.handle);
  lifecycle.useLifecycle.setState({ batterySaver: true });

  const freezing = lifecycle.freezeTab(b);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Before the engine answers, the tab is shown (which unfreezes it) and typed in, then left again.
  S().activate(b);
  page.dirty = true;
  page.release();
  await freezing;
  S().activate(a);

  assert.equal(await lifecycle.sleepTab(b), false);
  assert.equal(page.evaluated, 1, "asks the page now");
  assert.equal(page.discarded, 0);
  webviews.delete(b);
});

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
    lifecycle.useLifecycle.setState({ batterySaver: true });
    assert.equal(await lifecycle.freezeTab(awake), false, "Battery Saver keeps the protected site running");
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
