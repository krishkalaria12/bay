import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore, useBrowser } from "../store/browser.ts";
import { engineProfile, engineProfileFor, IDLE_LIVE, viewTabIds } from "../store/model.ts";
import { DEFAULT_SPACE } from "../store/spaces.ts";
import { DEFAULT_SETTINGS } from "../store/settings.ts";
import { createBrowserAuthority } from "./authority.ts";
import { createBrowserProjector } from "./projection.ts";
import { setAppUrlOpener } from "../store/tabs.ts";

const request = (requestId, command, extra = {}) => ({ epoch: "epoch-1", clientId: "window-1", requestId, command, ...extra });

test("isolated stores never call the default application's URL opener", () => {
  const calls = [];
  setAppUrlOpener((...args) => {
    calls.push(args);
    return true;
  });
  try {
    const store = createBrowserStore();
    const w = store.getState().createWindow();
    const t = store.getState().newTab(w, { url: "https://isolated.example/" });
    store.getState().navigate(t, "https://next.example/");
    assert.deepEqual(calls, []);
    assert.equal(store.getState().tabs[t].navigation.url, "https://next.example/");
    const custom = createBrowserStore({ openAppUrl: (url) => url === "https://handled.example/" });
    const customWindow = custom.getState().createWindow();
    assert.equal(custom.getState().newTab(customWindow, { url: "https://handled.example/" }), "");
  } finally {
    setAppUrlOpener(() => false);
  }
});

test("factories isolate state, private cleanup, and shared engine profile mappings", () => {
  const original = useBrowser.getState();
  const a = createBrowserStore();
  const b = createBrowserStore();
  const owner = a.getState().createSpace({ name: "Owner" });
  const shared = a.getState().createSpace({ name: "Shared", shareWith: owner });
  assert.equal(engineProfileFor(shared, a.getState().spaces), owner);
  assert.equal(engineProfile(shared), shared, "isolated stores never publish the macOS global registry");
  assert.equal(b.getState().spaces[shared], undefined);
  const mark = a.getState().addBookmark({ spaceId: shared, url: "https://shared.example/", title: "Shared" });
  assert.equal(a.getState().bookmarks.nodes[mark].parentId, `bar@${owner}`);
  const w = a.getState().createWindow({ incognito: true, url: "https://secret.example/" });
  a.setState({ privateCleanedTabs: { [w]: [] }, privateSiteMutes: { [w]: { "secret.example": true } } });
  a.getState().closeWindow(w);
  assert.deepEqual(a.getState().privateCleanedTabs, {});
  assert.deepEqual(a.getState().privateSiteMutes, {});
  assert.deepEqual(b.getState().windowOrder, []);
  assert.equal(useBrowser.getState(), original);
});

test("projections detach and freeze JSON data while preserving native page state", () => {
  const store = createBrowserStore();
  const w = store.getState().createWindow({ url: "https://example.com/" });
  const t = viewTabIds(store.getState(), w)[0];
  store.getState().updateTab(t, { adoptId: "transfer:42" }, { isLoading: true, progress: 0.5 });
  const project = createBrowserProjector();
  const p = project(store.getState());
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
  assert.equal(p.tabs[t].adoptId, "transfer:42");
  assert.ok(p.tabs[t].navigation.seq > 0);
  assert.equal(p.live[t].progress, 0.5);
  assert.ok(!("hydrate" in p) && !("newTab" in p) && !("setState" in p));
  assert.throws(() => {
    p.tabs[t].url = "https://changed.example/";
  }, TypeError);
  assert.throws(() => {
    p.settings.shortcuts.other = [];
  }, TypeError);
  assert.notEqual(p.settings, store.getState().settings);
  for (const value of [DEFAULT_SETTINGS, DEFAULT_SPACE, IDLE_LIVE]) assert.ok(!Object.isFrozen(value));
  store.getState().updateTab(t, { title: "Later" });
  const next = project(store.getState());
  assert.equal(p.tabs[t].title, "");
  assert.equal(next.tabs[t].title, "Later");
  assert.equal(next.settings, p.settings);
  assert.notEqual(next.tabs, p.tabs);
});

test("commands execute in order and reply with immutable committed results", async () => {
  const authority = createBrowserAuthority({ epoch: "epoch-1" });
  const commits = [];
  authority.subscribe((commit) => commits.push(commit));
  const opened = await authority.dispatch(request(1, { method: "createWindow", options: { url: "https://one.example/" } }));
  const w = opened.value;
  assert.ok(opened.commit.state.windows[w]);
  const [a, b] = await Promise.all([
    authority.dispatch(request(2, { method: "newTab", windowId: w, options: { url: "https://two.example/" } })),
    authority.dispatch(request(3, { method: "newTab", windowId: w, options: { url: "https://three.example/" } })),
  ]);
  assert.ok(a.commit.state.tabs[a.value]);
  assert.equal(a.commit.state.tabs[b.value], undefined);
  assert.ok(b.commit.state.tabs[a.value] && b.commit.state.tabs[b.value]);
  assert.deepEqual(
    commits.map((c) => c.revision),
    [1, 2, 3],
  );
  assert.equal(authority.getSnapshot(), b.commit);
  assert.equal(viewTabIds(opened.commit.state, w).length, 1);
  authority.close();
});

test("invalid and stale requests cannot mutate state or block later commands", async () => {
  const authority = createBrowserAuthority({ epoch: "epoch-1" });
  const before = authority.getSnapshot();
  for (const input of [
    request(1, { method: "hydrate", options: {} }),
    request(1, { method: "updateLive", tabId: "tab", patch: {} }),
    request(1, { method: "createWindow", options: { incognito: "yes" } }),
    request(1, { method: "createWindow", options: { adoptId: "privileged" } }),
    request(1, { method: "navigate", tabId: "tab", url: 2 }),
    request(1, { method: "closeWindow", windowId: "missing", unexpected: true }),
    request(0, { method: "createWindow" }),
  ])
    await assert.rejects(authority.dispatch(input), { code: "invalid_request" });
  await assert.rejects(authority.dispatch(request(1, { method: "createWindow" }, { epoch: "old" })), { code: "stale_epoch" });
  assert.equal(authority.getSnapshot(), before);
  const good = await authority.dispatch(request(1, { method: "createWindow" }));
  assert.equal(good.commit.revision, 1);
  authority.close();
  await assert.rejects(authority.dispatch(request(2, { method: "createWindow" })), { code: "closed" });
});

test("duplicate requests share results and conflicting reuse is rejected", async () => {
  const authority = createBrowserAuthority({ epoch: "epoch-1" });
  const command = request(1, { method: "createWindow" });
  const first = authority.dispatch(command);
  assert.equal(authority.dispatch(command), first);
  const reply = await first;
  assert.equal(await authority.dispatch(command), reply);
  await assert.rejects(authority.dispatch(request(1, { method: "createWindow", options: { incognito: true } })), { code: "request_conflict" });
  assert.equal(authority.getSnapshot().state.windowOrder.length, 1);
  const other = await authority.dispatch(request(1, { method: "createWindow" }, { clientId: "window-2" }));
  assert.notEqual(other.value, reply.value);
  authority.close();
});

test("evicted requests are rejected instead of executed again", async () => {
  const authority = createBrowserAuthority({ epoch: "epoch-1" });
  const first = request(1, { method: "reopenClosedWindow" });
  await authority.dispatch(first);
  for (let id = 2; id <= 131; id++) await authority.dispatch(request(id, { method: "reopenClosedWindow" }));
  await assert.rejects(authority.dispatch(first), { code: "request_expired" });
  authority.close();
});

for (const external of [false, true])
  test(`${external ? "external native fact" : "command"} publishes final nested private cleanup once`, async () => {
    const store = createBrowserStore();
    const w = store.getState().createWindow({ incognito: true, url: "https://secret.example/" });
    store.setState({ privateCleanedTabs: { [w]: [] }, privateSiteMutes: { [w]: { "secret.example": true } } });
    const authority = createBrowserAuthority({ epoch: "epoch-1", store });
    const commits = [];
    authority.subscribe((commit) => commits.push(commit));
    if (external) store.getState().closeWindow(w);
    else await authority.dispatch(request(1, { method: "closeWindow", windowId: w }));
    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0].state.privateSiteMutes, {});
    assert.deepEqual(commits[0].state.privateCleanedTabs, {});
    assert.equal(commits[0].state.windows[w], undefined);
    authority.close();
  });

test("a reducer failure does not block the next queued command", async () => {
  const store = createBrowserStore();
  const w = store.getState().createWindow();
  store.setState({
    newTab() {
      throw new Error("reducer failed");
    },
  });
  const authority = createBrowserAuthority({ epoch: "epoch-1", store });
  const failed = authority.dispatch(request(1, { method: "newTab", windowId: w }));
  const next = authority.dispatch(request(2, { method: "createWindow" }));
  await assert.rejects(failed, /reducer failed/);
  assert.ok((await next).value);
  authority.close();
});

test("a projection failure cannot acknowledge an older snapshot", async () => {
  const store = createBrowserStore();
  const authority = createBrowserAuthority({ epoch: "epoch-1", store });
  const before = authority.getSnapshot();
  assert.throws(() => store.setState({ settings: { ...store.getState().settings, sidebarWidth: NaN } }), /non-JSON/);
  await assert.rejects(authority.dispatch(request(1, { method: "reopenClosedWindow" })), /non-JSON/);
  assert.equal(authority.getSnapshot(), before);
  store.setState({ settings: { ...store.getState().settings, sidebarWidth: 250 } });
  const reply = await authority.dispatch(request(2, { method: "reopenClosedWindow" }));
  assert.equal(reply.commit.state.settings.sidebarWidth, 250);
  assert.equal(reply.commit.revision, 1);
  authority.close();
});

test("reentrant subscribers see commits in the same order", () => {
  const store = createBrowserStore();
  const authority = createBrowserAuthority({ epoch: "epoch-1", store });
  const seen = [];
  authority.subscribe((commit) => {
    if (commit.revision === 1) store.getState().setAppDark(false);
  });
  authority.subscribe((commit) => seen.push(commit.revision));
  store.getState().createWindow();
  assert.deepEqual(seen, [1, 2]);
  authority.close();
});

test("location intents publish panel dismissal and tab changes as one committed result", async () => {
  const store = createBrowserStore();
  const w = store.getState().createWindow({ url: "source.com" });
  const tabId = viewTabIds(store.getState(), w)[0];
  store.getState().openPanel(w);
  const authority = createBrowserAuthority({ epoch: "epoch-1", store });
  const commits = [];
  authority.subscribe((commit) => commits.push(commit));
  const reply = await authority.dispatch(request(1, { method: "openLocation", sourceTabId: tabId, url: "next.com", disposition: "newTab" }));
  assert.equal(reply.value, null);
  assert.equal(commits.length, 1);
  assert.equal(commits[0], reply.commit);
  assert.equal(reply.commit.state.windowUi[w].panel.open, false);
  assert.equal(viewTabIds(reply.commit.state, w).length, 2);
  await authority.dispatch(request(2, { method: "requestNewTab", windowId: w }));
  const before = commits.length;
  const submitted = await authority.dispatch(request(3, { method: "submitNewTab", windowId: w, url: "third.com" }));
  assert.equal(submitted.value, null);
  assert.equal(commits.length, before + 1);
  assert.equal(submitted.commit.state.windowUi[w].panel.open, false);
  assert.equal(viewTabIds(submitted.commit.state, w).length, 3);
  authority.close();
});

test("invalid location intent ownership leaves authority unchanged and later commands usable", async () => {
  const store = createBrowserStore();
  const w = store.getState().createWindow();
  const authority = createBrowserAuthority({ epoch: "epoch-1", store });
  const before = authority.getSnapshot();
  await assert.rejects(authority.dispatch(request(1, { method: "openLocation", sourceTabId: "missing", url: "x.com", disposition: "newTab" })), {
    code: "invalid_request",
  });
  assert.equal(authority.getSnapshot(), before);
  const reply = await authority.dispatch(request(2, { method: "openCommandPanel", windowId: w, initialText: "" }));
  assert.equal(reply.value, null);
  assert.equal(reply.commit.state.windowUi[w].panel.mode, "navigate");
  authority.close();
});

test("authority routes focus through an injected effect and commits the final destination", async () => {
  const store = createBrowserStore();
  const source = store.getState().createWindow({ url: "source.com" });
  const target = store.getState().createWindow({ url: "target.com" });
  store.getState().setFocusedWindow(source);
  const focused = [];
  const authority = createBrowserAuthority({ epoch: "epoch-1", store, effects: { focusWindow: (id) => focused.push(id) } });
  const reply = await authority.dispatch(
    request(1, { method: "switchToExistingTab", sourceTabId: viewTabIds(store.getState(), source)[0], targetTabId: viewTabIds(store.getState(), target)[0] }),
  );
  assert.equal(reply.value, null);
  assert.equal(reply.commit.revision, 1);
  assert.equal(reply.commit.state.ui.focusedWindowId, target);
  assert.deepEqual(focused, [target]);
  authority.close();
});

test("createWindow commands select a space and reject the removed profile option", async () => {
  const store = createBrowserStore();
  const spaceId = store.getState().createSpace({ name: "Work" });
  const authority = createBrowserAuthority({ epoch: "epoch-1", store });
  await assert.rejects(authority.dispatch(request(1, { method: "createWindow", options: { profileId: spaceId } })), { code: "invalid_request" });
  const reply = await authority.dispatch(request(1, { method: "createWindow", options: { spaceId } }));
  assert.equal(reply.commit.state.windows[reply.value].spaceId, spaceId);
  authority.close();
});

test("native handoff mutations share command order and publish one final commit", async () => {
  const store = createBrowserStore();
  const windowId = store.getState().createWindow();
  const authority = createBrowserAuthority({ store, epoch: "native-open" });
  const commits = [];
  authority.subscribe((commit) => commits.push(commit));
  const before = authority.dispatch({
    epoch: "native-open",
    clientId: "one",
    requestId: 1,
    command: { method: "newTab", windowId, options: { url: "https://first.example/" } },
  });
  const native = authority.dispatchNative((owner) => {
    const a = owner.getState().newTab(windowId, { url: "https://posted.example/", adoptId: "trusted-native-offer" });
    owner.getState().openPeek(a, "https://peek.example/", "trusted-peek-offer");
    return a;
  });
  const after = authority.dispatch({
    epoch: "native-open",
    clientId: "one",
    requestId: 2,
    command: { method: "newTab", windowId, options: { url: "https://last.example/" } },
  });
  const [a, b, c] = await Promise.all([before, native, after]);
  assert.deepEqual([a.commit.revision, b.commit.revision, c.commit.revision], [1, 2, 3]);
  assert.equal(commits.length, 3);
  assert.equal(b.commit.state.tabs[b.value].adoptId, "trusted-native-offer");
  assert.ok(b.commit.state.peeks[windowId]);
  authority.close();
});

test("service IO deduplicates without blocking tab commands or service-only publications", async () => {
  const store = createBrowserStore();
  const windowId = store.getState().createWindow();
  let complete, entered;
  const running = new Promise((resolve) => {
    entered = resolve;
  });
  const io = new Promise((resolve) => {
    complete = resolve;
  });
  let calls = 0;
  const authority = createBrowserAuthority({
    epoch: "epoch-1",
    store,
    executeAsync: async () => {
      calls++;
      entered();
      await io;
      return null;
    },
  });
  const input = request(1, { method: "serviceAction", action: "calendarRefresh", args: [] });
  const service = authority.dispatch(input);
  assert.equal(authority.dispatch(input), service);
  await running;
  const tab = await authority.dispatch(request(2, { method: "newTab", windowId, options: { url: "https://while-service-runs.example/" } }));
  assert.ok(store.getState().tabs[tab.value]);
  store.setState({ services: { calendar: { access: "notDetermined", calendars: [], events: [], loading: false, error: null, lastFetch: null } } });
  const latest = authority.getSnapshot();
  assert.ok(latest.revision > tab.commit.revision);
  complete();
  assert.equal((await service).commit, latest);
  assert.equal(calls, 1);
  authority.close();
});

test("retired authority rejects a late service reply without replay", async () => {
  let complete, entered;
  const running = new Promise((resolve) => {
    entered = resolve;
  });
  const io = new Promise((resolve) => {
    complete = resolve;
  });
  let active;
  const authority = createBrowserAuthority({
    epoch: "epoch-1",
    executeAsync: async (_command, isActive) => {
      active = isActive;
      entered();
      await io;
      return null;
    },
  });
  const reply = authority.dispatch(request(1, { method: "serviceAction", action: "calendarRefresh", args: [] }));
  await running;
  authority.close();
  assert.equal(active(), false);
  complete();
  await assert.rejects(reply, { code: "closed" });
});
