import assert from "node:assert/strict";
import { test } from "node:test";
import "../../../apps/browser/src/test-loader.mjs";

const listeners = new Set();

globalThis.nnTestNativeModules = {
  BayCEF: {
    addListener(name, listener) {
      assert.equal(name, "onEngineEvent");
      listeners.add(listener);

      return { remove: () => listeners.delete(listener) };
    },
  },
};

const { onEngineEvent } = await import("./engineInfo.ts");
const { onHistoryChanged } = await import("./history.ts");
const { onBookmarksChanged } = await import("./bookmarks.ts");
const { onCliControlChanged } = await import("./nativeModule.ts");

const emit = (topic, payload) => {
  for (const listener of listeners) listener({ topic, payload });
};

test("a topic filter delivers matching payloads in order and ignores other topics", (t) => {
  const received = [];
  const sub = onEngineEvent((topic, payload) => received.push([topic, payload]), "history.changed");
  t.after(() => sub.remove());
  emit("bookmarks.changed", '{"profile":"other"}');
  emit("history.changed", '{"profile":"first","kind":"visit"}');
  emit("history.changed", '{"profile":"second","kind":"deleted"}');
  assert.deepEqual(received, [
    ["history.changed", { profile: "first", kind: "visit" }],
    ["history.changed", { profile: "second", kind: "deleted" }],
  ]);
});

test("irrelevant malformed JSON is skipped before parsing", (t) => {
  const sub = onEngineEvent(() => assert.fail("irrelevant event delivered"), "history.changed");
  t.after(() => sub.remove());
  assert.doesNotThrow(() => emit("tabs.strip", "{malformed"));
  assert.throws(() => emit("history.changed", "{malformed"), SyntaxError);
});

test("generic listeners receive all topics and still parse their payloads", (t) => {
  const received = [];
  const sub = onEngineEvent((topic, payload) => received.push([topic, payload]));
  t.after(() => sub.remove());
  emit("history.changed", '{"profile":"a"}');
  emit("tabs.strip", '{"profile":"b","tabs":[]}');
  assert.deepEqual(received, [
    ["history.changed", { profile: "a" }],
    ["tabs.strip", { profile: "b", tabs: [] }],
  ]);
  assert.throws(() => emit("unrecognized", "{malformed"), SyntaxError);
});

test("listeners retain independent parsed payloads", (t) => {
  let first;
  let second;

  const a = onEngineEvent((_topic, payload) => {
    first = payload;
    payload.nested.value = "changed";
  }, "history.changed");

  const b = onEngineEvent((_topic, payload) => {
    second = payload;
  });

  t.after(() => {
    a.remove();
    b.remove();
  });
  emit("history.changed", '{"profile":"a","nested":{"value":"original"}}');
  assert.notStrictEqual(first, second);
  assert.equal(first.nested.value, "changed");
  assert.equal(second.nested.value, "original");
});

test("removing filtered and generic subscriptions detaches their native listeners", () => {
  const a = onEngineEvent(() => assert.fail("removed filtered listener called"), "history.changed");
  const b = onEngineEvent(() => assert.fail("removed generic listener called"));
  assert.equal(listeners.size, 2);
  a.remove();
  a.remove();
  b.remove();
  assert.equal(listeners.size, 0);
  emit("history.changed", "{malformed");
});

test("history, bookmarks and CLI subscribers filter before decoding and preserve delivery", (t) => {
  const history = [];
  const bookmarks = [];
  const cli = [];

  const subs = [
    onHistoryChanged((change) => history.push(change)),
    onBookmarksChanged((profile) => bookmarks.push(profile)),
    onCliControlChanged((status) => cli.push(status)),
  ];

  t.after(() => {
    for (const sub of subs) sub.remove();
  });
  assert.doesNotThrow(() => emit("tabs.strip", "{malformed"));
  emit(
    "history.changed",
    JSON.stringify({
      profile: "work",
      kind: "batch",
      changes: [
        { kind: "visit", u: "https://example.com", t: "Example", n: 1, at: 12 },
        { kind: "modified", rows: [{ u: "https://example.com", t: "Updated", n: 2 }] },
        { kind: "deleted", all: false, urls: ["https://example.com"] },
      ],
    }),
  );
  emit("history.changed", '{"profile":"personal","kind":"deleted","all":true}');
  emit("bookmarks.changed", '{"profile":"work"}');
  emit("cliControl", '{"state":"invalid"}');

  for (const state of ["off", "starting", "on", "external"]) emit("cliControl", JSON.stringify({ state, connections: 2 }));
  assert.deepEqual(history, [
    { kind: "visit", profile: "work", url: "https://example.com", title: "Example", visits: 1, at: 12 },
    { kind: "modified", profile: "work", rows: [{ url: "https://example.com", title: "Updated", visits: 2 }] },
    { kind: "deleted", profile: "work", all: false, urls: ["https://example.com"] },
    { kind: "deleted", profile: "personal", all: true, urls: [] },
  ]);
  assert.deepEqual(bookmarks, ["work"]);
  assert.deepEqual(
    cli,
    ["off", "starting", "on", "external"].map((state) => ({ state, connections: 2 })),
  );
});
