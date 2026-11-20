#!/usr/bin/env node
// What one state change costs on the Windows/Linux runtime path, run in Node: the coordinator projects and publishes a
// commit, a window's transport parses it and its client takes it, as runtime/coordinator.ts and runtime/client.ts do
// over Mojo. The browser process is left out (it forwards the JSON here). The state is js-bench's seed profile
// (seed.mjs: 200 tabs, 5000 history entries, 1000 bookmarks).
//
//   cd apps/browser && node --no-warnings --import ./src/test-loader.mjs scripts/perf/runtime-bench.mjs [rounds]
//
// Prints each stage's median from Bay's own spans, and JSON.stringify/JSON.parse of the same commit as the floor a
// full-state commit can't go under.

import { PerformanceObserver } from "node:perf_hooks";

await import("../../src/test-native-stub.mjs");

const { createBrowserStore } = await import("../../src/store/browserStore.ts");
const { createBrowserProjector } = await import("../../src/runtime/projection.ts");
const { createBrowserClient } = await import("../../src/runtime/client.ts");
const { createAppRuntimeTransport } = await import("../../../../packages/platform/src/runtimeTransport.ts");
const { buildSeed } = await import("./seed.mjs");

const rounds = Number(process.argv[2] ?? 60);
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;
const tick = () => new Promise(setImmediate);

const seed = buildSeed("http://127.0.0.1:47817");
const store = createBrowserStore();
const tabs = Object.fromEntries(seed["session.json"].tabs.map((tab) => [tab.id, tab]));

store.setState({ tabs, history: seed["history.json"].history, bookmarks: seed["bookmarks.json"].bookmarks ?? store.getState().bookmarks });

const project = createBrowserProjector();
const epoch = "epoch-bench";
const envelope = (value) => ({ resultJson: JSON.stringify({ value }) });

function endpoints(bootstrap, onPublish) {
  const handlers = new Map();
  let next = 0;

  const router = (name) => ({
    addListener(callback) {
      handlers.set(++next, { name, callback });

      return next;
    },
    removeListener: (key) => handlers.delete(key),
  });

  const client = {
    onCommit: router("commit"),
    onCommand: router("command"),
    onRuntimeClosed: router("closed"),
    onConnectionError: router("error"),
    removeListener: (key) => handlers.delete(key),
    $: { bindNewPipeAndPassRemote: () => "pipe", close() {} },
  };

  const remote = {
    connect: async () => envelope(bootstrap),
    getSnapshot: async () => ({ resultJson: `{"value":${latest}}` }),
    dispatch: async () => envelope(null),
    publish: async (json) => {
      onPublish(json);

      return envelope(null);
    },
    resolve: async () => envelope(null),
    ready: async () => envelope(null),
    onConnectionError: router("error"),
    $: { close() {} },
  };

  const emit = (name, ...args) => {
    for (const { name: kind, callback } of handlers.values()) if (kind === name) callback(...args);
  };

  return { client, remote, emit };
}

let latest = "";
const windows = [];

const coordinatorEnds = endpoints({ version: 1, role: "coordinator", epoch, clientId: "coordinator" }, (json) => {
  latest = json;

  for (const window of windows) window.emit("commit", json);
});

const coordinator = await createAppRuntimeTransport({ ...coordinatorEnds, expectedRole: "coordinator" });

const windowEnds = endpoints({ version: 1, role: "window", epoch, clientId: "window-1", windowId: "w-bench" });

windows.push(windowEnds);

let revision = 0;

await coordinator.publish({ epoch, revision, state: project(store.getState()) });

const transport = await createAppRuntimeTransport({ ...windowEnds, expectedRole: "window" });
const client = createBrowserClient({ clientId: "window-1", transport: { ...transport, subscribeClose: transport.subscribeClose } });

await client.ready;

const samples = new Map();

const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (!samples.has(entry.name)) samples.set(entry.name, []);
    samples.get(entry.name).push(entry.duration);
  }
});

observer.observe({ entryTypes: ["measure"] });

globalThis.bayProfiling.start();

const ids = Object.keys(tabs);
const totals = { project: [], publish: [], stringify: [], parse: [] };

for (let i = 0; i < rounds; i++) {
  // A page's title changing: the kind of update a loading page sends many times.
  const id = ids[i % ids.length];
  store.setState((s) => ({ tabs: { ...s.tabs, [id]: { ...s.tabs[id], title: `Title ${i}` } } }));

  let t = performance.now();
  const commit = { epoch, revision: ++revision, state: project(store.getState()) };
  totals.project.push(performance.now() - t);

  t = performance.now();
  await coordinator.publish(commit);
  totals.publish.push(performance.now() - t);

  t = performance.now();
  const json = JSON.stringify(commit);
  totals.stringify.push(performance.now() - t);

  t = performance.now();
  JSON.parse(json);
  totals.parse.push(performance.now() - t);
}

await tick();

globalThis.bayProfiling.stop();

observer.disconnect();

if (client.getSnapshot()?.revision !== revision) throw new Error(`the window is at revision ${client.getSnapshot()?.revision}, expected ${revision}`);

const row = (name, values) => console.log(`${name.padEnd(36)} ${median(values).toFixed(3).padStart(8)} ms`);

console.log(`commit: ${(latest.length / 1024).toFixed(0)} KB, ${rounds} rounds, one window\n`);

row("coordinator project", totals.project);

for (const name of ["Bay.runtime encodeCommit", "Bay.runtime decodeCommit", "Bay.client decodeCommit", "Bay.client applyCommit"])
  if (samples.has(name)) row(name, samples.get(name));

row("publish to window, end to end", totals.publish);

row("floor: JSON.stringify", totals.stringify);

row("floor: JSON.parse", totals.parse);
