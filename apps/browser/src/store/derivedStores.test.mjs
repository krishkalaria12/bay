import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import {
  recordStores,
  selectStore,
  tabStore,
  tabLiveStore,
  windowStore,
  settingsStore,
  appearanceStore,
  spaceStore,
  spaceHeaderHiddenStore,
} from "./derivedStores.ts";
import { useBrowser } from "./browserStore.ts";
import { browserRead } from "./read.ts";
import { spaceFolded } from "./model.ts";

test("space folding inputs skip transient updates and follow single-space header changes", () => {
  useBrowser.getState().hydrate({});
  const w = useBrowser.getState().createWindow({ url: "https://example.com" });
  const id = useBrowser.getState().windows[w].activeTabIds.default;
  const space = spaceStore("default");
  let calls = 0;
  const stops = [space.subscribe(() => calls++), spaceHeaderHiddenStore.subscribe(() => calls++)];
  const folded = () => !!space.getState()?.folded && !spaceHeaderHiddenStore.getState();

  try {
    for (let i = 0; i < 60; i++) useBrowser.getState().updateLive(id, { progress: i / 100 });
    useBrowser.getState().setSelection(w, [id]);
    assert.equal(calls, 0);
    useBrowser.getState().updateSettings({ hideSingleSpaceHeader: true });
    useBrowser.getState().updateSpace("default", { folded: true });
    assert.equal(folded(), false, "a hidden header must not hide the section beneath it");
    const other = useBrowser.getState().createSpace({ name: "Other" });
    assert.equal(folded(), true, "adding a space restores the header and folding");
    assert.equal(folded(), spaceFolded(useBrowser.getState(), "default"));
    const before = calls;
    useBrowser.getState().updateSpace(other, { color: "plum" });
    useBrowser.getState().updateSettings({ unreadBadges: false });
    assert.equal(calls, before, "other spaces and unrelated settings must not notify the row");
    useBrowser.getState().hydrate({});
    assert.equal(folded(), spaceFolded(useBrowser.getState(), "default"));
  } finally {
    stops.forEach((stop) => stop());
  }
});

test("record views share one source subscription and only notify changed mounted IDs", () => {
  const source = createStore(() => ({ records: Object.fromEntries(Array.from({ length: 1000 }, (_, id) => [String(id), { id }])), other: 0 }));
  const subscribe = source.subscribe;
  let connections = 0;
  source.subscribe = (listener) => {
    connections++;
    const stop = subscribe(listener);

    return () => {
      connections--;
      stop();
    };
  };

  const view = recordStores(source, (s) => s.records);
  let calls = 0;
  const stops = Array.from({ length: 1000 }, (_, id) => view(String(id)).subscribe(() => calls++));
  assert.equal(connections, 1);
  source.setState({ other: 1 });
  assert.equal(calls, 0);
  source.setState((s) => ({ records: { ...s.records, 42: { id: 42, title: "changed" } } }));
  assert.equal(calls, 1, "999 unrelated row selectors should never run");
  assert.strictEqual(view("42").getState(), source.getState().records[42]);
  stops.forEach((stop) => stop());
  assert.equal(connections, 0, "no source listener remains when the views unmount");
});

test("record views handle creation, deletion, replacement, repeated unsubscribe and remount", () => {
  const source = createStore(() => ({ records: {} }));
  const view = recordStores(source, (s) => s.records)("tab");
  const values = [];
  const stop = view.subscribe((value) => values.push(value));
  const tab = { title: "A" };
  source.setState({ records: { tab } });
  source.setState({ records: { tab } });
  source.setState({ records: {} });
  source.setState({ records: { tab: { title: "B" } } });
  assert.deepEqual(values, [tab, undefined, { title: "B" }]);
  assert.equal(view.getInitialState(), undefined);
  stop();
  const remounted = view.subscribe((value) => values.push(value));
  stop();
  source.setState({ records: { tab } });
  assert.equal(values.length, 4, "an old unsubscribe must not detach a new consumer of the same ID");
  remounted();
});

test("views read the latest source during reentrant updates and respect unsubscription during publication", () => {
  const source = createStore(() => ({ records: { a: 0, b: 0 } }));
  const views = recordStores(source, (s) => s.records);
  const seen = [];
  let stopB = () => {};

  const stopA = views("a").subscribe((value) => {
    if (value === 1) {
      stopB();
      source.setState({ records: { a: 2, b: 2 } });
    }

    seen.push(views("a").getState());
  });

  stopB = views("b").subscribe(() => assert.fail("unsubscribed listener ran"));
  source.setState({ records: { a: 1, b: 1 } });
  assert.deepEqual(seen, [2, 2]);
  stopA();
});

test("field views share subscriptions and preserve Object.is semantics", () => {
  const source = createStore(() => ({ field: NaN, other: 0 }));
  const subscribe = source.subscribe;
  let connections = 0;
  source.subscribe = (listener) => {
    connections++;
    const stop = subscribe(listener);

    return () => {
      connections--;
      stop();
    };
  };

  const view = selectStore(source, (s) => s.field);
  const seen = [];
  const stop = view.subscribe((value) => seen.push(value));
  const others = Array.from({ length: 1000 }, () => view.subscribe(() => {}));
  assert.equal(connections, 1);
  source.setState({ other: 1 });
  source.setState({ field: NaN });
  source.setState({ field: 0 });
  source.setState({ field: -0 });
  assert.equal(seen.length, 2);
  assert.ok(Object.is(seen[1], -0));
  assert.ok(Number.isNaN(view.getInitialState()));
  stop();
  others.forEach((stop) => stop());
  assert.equal(connections, 0);
});

test("browser views route live reports separately from tab, window, settings and appearance changes", () => {
  useBrowser.getState().hydrate({});
  const w = useBrowser.getState().createWindow({ url: "https://one.example" });
  const id = useBrowser.getState().windows[w].activeTabIds.default;
  const other = useBrowser.getState().newTab(w, { url: "https://two.example", background: true });
  const counts = { tab: 0, live: 0, other: 0, window: 0, settings: 0, appearance: 0 };

  const stops = [
    tabStore(id).subscribe(() => counts.tab++),
    tabLiveStore(id).subscribe(() => counts.live++),
    tabLiveStore(other).subscribe(() => counts.other++),
    windowStore(w).subscribe(() => counts.window++),
    settingsStore.subscribe(() => counts.settings++),
    appearanceStore.subscribe(() => counts.appearance++),
  ];

  try {
    for (let i = 1; i <= 60; i++) useBrowser.getState().updateLive(other, { progress: i / 100 });
    assert.deepEqual(counts, { tab: 0, live: 0, other: 60, window: 0, settings: 0, appearance: 0 });
    useBrowser.getState().updateTab(id, { title: "new" });
    assert.equal(counts.tab, 1);
    useBrowser.getState().toggleSidebar(w);
    assert.equal(counts.window, 1);
    useBrowser.getState().updateSettings({ density: "compact" });
    assert.equal(counts.settings, 1);
    useBrowser.getState().setAppDark(!useBrowser.getState().ui.appDark);
    assert.equal(counts.appearance, 1);
    useBrowser.getState().hydrate({});
    assert.equal(tabStore(id).getState(), undefined);
    assert.equal(tabLiveStore(id).getState(), undefined);
    assert.equal(windowStore(w).getState(), undefined);
  } finally {
    stops.forEach((stop) => stop());
  }
});

test("the quiet view skips live updates and follows everything else", async () => {
  const { quietStore } = await import("./derivedStores.ts");
  useBrowser.getState().hydrate({});
  const w = useBrowser.getState().createWindow({ url: "https://example.com" });
  const id = useBrowser.getState().windows[w].activeTabIds.default;
  let calls = 0;
  const stop = quietStore.subscribe(() => calls++);

  try {
    for (let i = 0; i < 20; i++) useBrowser.getState().updateLive(id, { progress: i / 100 });
    assert.equal(calls, 0);
    assert.strictEqual(quietStore.getState(), browserRead.getState());
    useBrowser.getState().updateTab(id, { title: "New" }, { progress: 0.5 });
    assert.equal(calls, 1, "a change with live in it still notifies");
    useBrowser.getState().setSelection(w, [id]);
    assert.equal(calls, 2);
    useBrowser.getState().updateSettings({ unreadBadges: false });
    assert.equal(calls, 3);
  } finally {
    stop();
  }
});

test("scoped and engine views follow the installed runtime source and restore the local source", async () => {
  const { createBrowserStore } = await import("./browserStore.ts");
  const { browserRead, createLocalBrowserReadSource } = await import("./read.ts");
  const { quietStore } = await import("./derivedStores.ts");
  const { useEngineView } = await import("./engineView.ts");
  const remote = createBrowserStore();
  const w = remote.getState().createWindow({ url: "https://remote.example" });
  const id = remote.getState().windows[w].activeTabIds.default;
  const restore = browserRead.install(createLocalBrowserReadSource(remote));
  let durable = 0;
  let live = 0;
  const stops = [quietStore.subscribe(() => durable++), tabLiveStore(id).subscribe(() => live++)];
  try {
    assert.equal(tabStore(id).getState().url, "https://remote.example");
    assert.strictEqual(useEngineView.getState().tabs, browserRead.getState().tabs);
    remote.getState().updateLive(id, { progress: 0.5 });
    assert.equal(live, 1);
    assert.equal(durable, 0);
    remote.getState().updateTab(id, { engine: "webkit" });
    assert.equal(durable, 1);
    assert.equal(useEngineView.getState().tabs[id].engine, "webkit");
    useBrowser.getState().hydrate({});
    assert.equal(durable, 1, "a renderer's unused local store must not notify runtime consumers");
    assert.equal(tabStore(id).getState().url, "https://remote.example");
  } finally {
    stops.forEach((stop) => stop());
    restore();
  }
  assert.equal(tabStore(id).getState(), undefined);
  assert.strictEqual(useEngineView.getState().tabs, browserRead.getState().tabs);
});
