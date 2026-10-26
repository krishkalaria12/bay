import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// The editor only needs showToast from the layout actions. Loading the rest would pull in native UI.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "../layout/splitActions" && context.parentURL?.endsWith("/boosts/editor.ts")) {
      return { url: "data:text/javascript,export const showToast = (...args) => globalThis.boostTestToasts.push(args)", shortCircuit: true };
    }
    return next(specifier, context);
  },
});
globalThis.boostTestToasts = [];
const native = await import("../../test-native-stub.mjs");
const { useBrowser } = await import("../../store/browser.ts");
const { webviews } = await import("../../lib/webviews.ts");
const { exportBoost, newBoost } = await import("../../lib/boosts.ts");
const { useBoosts, startBoosts } = await import("./state.ts");
const editor = await import("./editor.ts");
const S = () => useBrowser.getState();
const E = () => editor.useBoostEditor.getState();

function setup() {
  editor.useBoostEditor.setState({ sessions: {} });
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  const tabId = S().windows[w].activeTabIds[S().windows[w].spaceId];
  startBoosts();
  useBoosts.setState({
    loaded: true,
    error: null,
    on: true,
    scriptsAcknowledged: false,
    boosts: { a: newBoost("a", "a.example", 1), b: newBoost("b", "b.example", 1) },
    scripts: {},
  });
  const evaluations = [];
  webviews.clear();
  webviews.set(tabId, {
    evaluate: async (script) => {
      evaluations.push(script);
      return [];
    },
    focus() {},
    setBoostStyle() {},
  });
  globalThis.boostTestToasts.length = 0;
  return { tabId, evaluations };
}
const move = (tabId, url) => useBrowser.setState((s) => ({ tabs: { ...s.tabs, [tabId]: { ...s.tabs[tabId], url } } }));
const pendingFile = () => {
  let answer;
  native.shellDialogAnswers.openTextFile = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  return (value) => answer(value);
};

test("explicit open and switch cannot put another site's boost over the page", () => {
  const { tabId } = setup();
  editor.openBoostEditor(tabId, { boostId: "b" });
  assert.equal(E().sessions[tabId], undefined);
  editor.openBoostEditor(tabId, { boostId: "a" });
  editor.switchEditorBoost(tabId, "b");
  assert.equal(E().sessions[tabId].boostId, "a");
});

test("an import whose dialog outlives a host change stays in the library", async () => {
  const { tabId } = setup();
  const answer = pendingFile();
  const importing = editor.importBoostFile(tabId);
  move(tabId, "https://b.example/");
  answer(exportBoost(newBoost("imported", "a.example", 1)));
  await importing;
  assert.equal(E().sessions[tabId], undefined);
  assert.equal(Object.values(useBoosts.getState().boosts).filter((b) => b.host === "a.example").length, 2);
});

test("an import for the current site still opens after its dialog", async () => {
  const { tabId } = setup();
  const answer = pendingFile();
  const importing = editor.importBoostFile(tabId);
  answer(exportBoost(newBoost("imported", "a.example", 1)));
  await importing;
  assert.equal(E().sessions[tabId].host, "a.example");
  assert.notEqual(E().sessions[tabId].boostId, "a");
});

test("an import cannot recreate an editor after its tab closes", async () => {
  const { tabId } = setup();
  const answer = pendingFile();
  const importing = editor.importBoostFile(tabId);
  useBrowser.setState((s) => ({ tabs: Object.fromEntries(Object.entries(s.tabs).filter(([id]) => id !== tabId)) }));
  answer(exportBoost(newBoost("imported", "a.example", 1)));
  await importing;
  assert.equal(E().sessions[tabId], undefined);
});

test("load completion uninstalls the active picker before clearing it", () => {
  const { tabId, evaluations } = setup();
  editor.openBoostEditor(tabId, { boostId: "a" });
  useBrowser.setState((s) => ({ live: { ...s.live, [tabId]: { ...s.live[tabId], isLoading: true } } }));
  editor.startPicking(tabId, "zap");
  const before = evaluations.length;
  useBrowser.setState((s) => ({ live: { ...s.live, [tabId]: { ...s.live[tabId], isLoading: false } } }));
  assert.equal(E().sessions[tabId].picking, null);
  assert.ok(evaluations.slice(before).some((script) => script.startsWith("const MODE = null;")));
});

test("messages from an old picker cannot edit or stop a replacement on the same boost", () => {
  const { tabId } = setup();
  editor.openBoostEditor(tabId, { boostId: "a" });
  editor.startPicking(tabId, "zap");
  const oldId = E().sessions[tabId].pickerId;
  editor.stopPicking(tabId);
  editor.startPicking(tabId, "zap");
  const pickerId = E().sessions[tabId].pickerId;
  assert.notEqual(pickerId, oldId);
  editor.onBoostMessage(tabId, { type: "select", mode: "zap", pickerId: oldId, selector: ".old" });
  editor.onBoostMessage(tabId, { type: "done", mode: "zap", pickerId: oldId });
  assert.deepEqual(useBoosts.getState().boosts.a.zaps, []);
  assert.equal(E().sessions[tabId].picking, "zap");
  editor.onBoostMessage(tabId, { type: "select", mode: "zap", pickerId, selector: ".current" });
  editor.onBoostMessage(tabId, { type: "done", mode: "zap", pickerId });
  assert.deepEqual(useBoosts.getState().boosts.a.zaps, [".current"]);
  assert.equal(E().sessions[tabId].picking, null);
});

test("a synced boost host change closes and uninstalls its editor", () => {
  const { tabId, evaluations } = setup();
  editor.openBoostEditor(tabId, { boostId: "a" });
  editor.startPicking(tabId, "zap");
  const before = evaluations.length;
  useBoosts.setState((s) => ({ boosts: { ...s.boosts, a: { ...s.boosts.a, host: "other.example" } } }));
  assert.equal(E().sessions[tabId], undefined);
  assert.ok(evaluations.slice(before).some((script) => script.startsWith("const MODE = null;")));
});

for (const mode of ["zap", "focus", "pick"]) {
  test(`escaped selectors survive the editor's ${mode} message path`, () => {
    const { tabId } = setup();
    editor.openBoostEditor(tabId, { boostId: "a" });
    editor.startPicking(tabId, mode);
    const pickerId = E().sessions[tabId].pickerId;
    const selector = "div#promo\\:banner.ad\\[slot\\]";
    editor.onBoostMessage(tabId, { type: "select", mode, pickerId, selector });
    const boost = useBoosts.getState().boosts.a;
    if (mode === "zap") assert.deepEqual(boost.zaps, [selector]);
    else if (mode === "focus") assert.deepEqual(boost.focus, [selector]);
    else {
      assert.ok(boost.css.includes(selector + " {"));
      assert.equal(E().sessions[tabId].view, "code");
    }
  });
}

function countingPage() {
  const { tabId } = setup();
  useBoosts.setState((s) => ({
    boosts: {
      ...s.boosts,
      a: { ...s.boosts.a, zaps: [".a"] },
      b: { ...s.boosts.b, host: "a.example", zaps: [".b"] },
    },
  }));
  const pending = [];
  webviews.get(tabId).evaluate = (script) => {
    if (!script.startsWith("const SELECTORS")) return Promise.resolve([]);
    return new Promise((resolve) => pending.push({ script, resolve }));
  };
  editor.openBoostEditor(tabId, { boostId: "a" });
  const answer = async (index, counts) => {
    pending[index].resolve(counts);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { tabId, pending, answer };
}

test("counts requested for A cannot populate B after switching boosts", async () => {
  const { tabId, pending, answer } = countingPage();
  editor.switchEditorBoost(tabId, "b");
  assert.equal(pending.length, 2);
  await answer(0, [7]);
  assert.deepEqual(E().sessions[tabId].counts, {});
  await answer(1, [3]);
  assert.deepEqual(E().sessions[tabId].counts, { ".b": 3 });
});

test("the newest count request wins when evaluations complete out of order", async () => {
  const { tabId, answer } = countingPage();
  const latest = editor.refreshCounts(tabId);
  await answer(1, [9]);
  await latest;
  await answer(0, [1]);
  assert.deepEqual(E().sessions[tabId].counts, { ".a": 9 });
});

test("closing and reopening the same boost invalidates its earlier count request", async () => {
  const { tabId, answer } = countingPage();
  editor.closeBoostEditor(tabId);
  editor.openBoostEditor(tabId, { boostId: "a" });
  await answer(1, [4]);
  await answer(0, [99]);
  assert.deepEqual(E().sessions[tabId].counts, { ".a": 4 });
});

for (const navigation of ["same-host URL", "same-URL navigation request", "loading start"]) {
  test(`${navigation} invalidates counts from the previous document`, async () => {
    const { tabId, answer } = countingPage();
    if (navigation === "same-host URL") move(tabId, "https://a.example/next");
    else if (navigation === "same-URL navigation request") {
      useBrowser.setState((s) => ({ tabs: { ...s.tabs, [tabId]: { ...s.tabs[tabId], navigation: { url: s.tabs[tabId].url, seq: 12345 } } } }));
    } else useBrowser.setState((s) => ({ live: { ...s.live, [tabId]: { ...s.live[tabId], isLoading: true } } }));
    await answer(0, [99]);
    assert.deepEqual(E().sessions[tabId].counts, {});
    const latest = editor.refreshCounts(tabId);
    await answer(1, [2]);
    await latest;
    assert.deepEqual(E().sessions[tabId].counts, { ".a": 2 });
  });
}

test("unrelated tab title and editor view updates keep a valid count request", async () => {
  const { tabId, answer } = countingPage();
  useBrowser.setState((s) => ({ tabs: { ...s.tabs, [tabId]: { ...s.tabs[tabId], title: "Updated title" } } }));
  editor.setEditorView(tabId, "code");
  await answer(0, [5]);
  assert.deepEqual(E().sessions[tabId].counts, { ".a": 5 });
});

function pendingConfirmation() {
  let resolve;
  const asked = [];
  native.shellDialogAnswers.confirm = (options) => {
    asked.push(options);
    return new Promise((answer) => {
      resolve = answer;
    });
  };
  return { asked, answer: (confirmed) => resolve({ confirmed, suppressed: false }) };
}

test("a deferred JavaScript confirmation cannot enable a boost whose synced host changed", async () => {
  const { tabId } = setup();
  const { answer } = pendingConfirmation();
  const enabling = editor.toggleBoostScript(tabId, "a", "a.example", true);
  useBoosts.setState((s) => ({ boosts: { ...s.boosts, a: { ...s.boosts.a, host: "other.example" } } }));
  answer(true);
  assert.equal(await enabling, false);
  assert.equal(useBoosts.getState().scripts.a?.enabled, undefined);
  assert.equal(useBoosts.getState().scriptsAcknowledged, false);
});

test("confirmation enables JavaScript only for the matching host and acknowledges its warning", async () => {
  const { tabId } = setup();
  const { answer, asked } = pendingConfirmation();
  const enabling = editor.toggleBoostScript(tabId, "a", "a.example", true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].title, "Run JavaScript on this site?");
  assert.equal(asked[0].windowId, S().tabs[tabId].windowId);
  assert.ok(asked[0].message.includes("every page of a.example"));
  answer(true);
  assert.equal(await enabling, true);
  assert.equal(useBoosts.getState().scripts.a.enabled, true);
  assert.equal(useBoosts.getState().scriptsAcknowledged, true);
});

test("cancelling the JavaScript warning changes neither consent nor enabled state", async () => {
  const { tabId } = setup();
  const { answer } = pendingConfirmation();
  const enabling = editor.toggleBoostScript(tabId, "a", "a.example", true);
  answer(false);
  assert.equal(await enabling, false);
  assert.equal(useBoosts.getState().scripts.a?.enabled, undefined);
  assert.equal(useBoosts.getState().scriptsAcknowledged, false);
});

test("navigation while the JavaScript warning is open prevents consent and enabling", async () => {
  const { tabId } = setup();
  const { answer } = pendingConfirmation();
  const enabling = editor.toggleBoostScript(tabId, "a", "a.example", true);
  move(tabId, "https://b.example/");
  answer(true);
  assert.equal(await enabling, false);
  assert.equal(useBoosts.getState().scripts.a?.enabled, undefined);
  assert.equal(useBoosts.getState().scriptsAcknowledged, false);
});

for (const stale of ["boost host", "tab host"]) {
  test(`an already acknowledged warning cannot enable JavaScript from a stale ${stale} render`, async () => {
    const { tabId } = setup();
    useBoosts.setState({ scriptsAcknowledged: true });
    const { asked } = pendingConfirmation();
    if (stale === "boost host") useBoosts.setState((s) => ({ boosts: { ...s.boosts, a: { ...s.boosts.a, host: "other.example" } } }));
    else move(tabId, "https://b.example/");
    assert.equal(await editor.toggleBoostScript(tabId, "a", "a.example", true), false);
    assert.equal(asked.length, 0);
    assert.equal(useBoosts.getState().scripts.a?.enabled, undefined);
  });
}

test("script toggles read current consent and disable without a warning", async () => {
  const { tabId } = setup();
  const { asked } = pendingConfirmation();
  useBoosts.setState({ scriptsAcknowledged: true });
  assert.equal(await editor.toggleBoostScript(tabId, "a", "a.example", true), true);
  assert.equal(asked.length, 0);
  useBoosts.setState({ scriptsAcknowledged: false });
  assert.equal(await editor.toggleBoostScript(tabId, "a", "a.example", false), true);
  assert.equal(useBoosts.getState().scripts.a.enabled, false);
  assert.equal(useBoosts.getState().scriptsAcknowledged, false);
  assert.equal(asked.length, 0);
});
