import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, emptyScope, syncScope } from "@bay/sync";
import { useBrowser } from "../store/browser.ts";
import { localFilesAdapter } from "./localFiles.ts";
import { configureSyncStore } from "./store.ts";

configureSyncStore(useBrowser);

const S = () => useBrowser.getState();
const pin = (id, order = 0, extra = {}) => ({
  id,
  spaceId: "default",
  path: `/Users/owner/Documents/${id}.pdf`,
  name: `${id}.pdf`,
  kind: "file",
  createdAt: 100,
  order,
  expanded: false,
  ...extra,
});

test("file sync exports a path whitelist with stable positions and no local access grants", () => {
  S().hydrate({});
  useBrowser.setState({ localFiles: { a: pin("a", 1, { bookmark: "secret", status: "available", fileUrl: "file:///secret" }), b: pin("b", 0) } });
  const adapter = localFilesAdapter("default");
  const { values } = adapter.extract(() => undefined);
  assert.deepEqual([...values.keys()], ["file:b", "file:a"]);
  assert.deepEqual(Object.keys(values.get("file:a")).sort(), ["a", "k", "n", "p", "pos"]);
  assert.equal(JSON.stringify([...values]).includes("secret"), false);
  const again = adapter.extract((key) => values.get(key));
  assert.deepEqual(again.values, values);
});

test("file sync repairs malformed base positions without passing them into fractional ordering", () => {
  S().hydrate({});
  useBrowser.setState({ localFiles: { a: pin("a", 0), b: pin("b", 1) } });
  const adapter = localFilesAdapter("default");
  for (const pos of [123, null, false, {}, [], "", "!", "V0", "0"]) {
    const { values } = adapter.extract(() => ({ pos }));
    const repaired = [...values.values()].map((record) => record.pos);
    assert.ok(
      repaired.every((value) => /^[0-9A-Za-z]+$/.test(value) && !value.endsWith("0")),
      String(pos),
    );
    assert.ok(repaired[0] < repaired[1], String(pos));
    assert.deepEqual(adapter.extract((key) => values.get(key)).values, values);
  }
});

test("incoming file records reject malformed and noncanonical fractional positions", () => {
  S().hydrate({});
  useBrowser.setState({ localFiles: { a: pin("a") } });
  const adapter = localFilesAdapter("default");
  for (const pos of [123, null, false, {}, [], "", "!", "V0", "0"]) {
    adapter.apply(new Map([["file:a", { p: "/Users/owner/replaced.pdf", n: "Replaced", k: "file", a: 100, pos }]]), new Set(["file:a"]));
    assert.deepEqual(S().localFiles.a, pin("a"), String(pos));
  }
});

test("incoming files retain local expansion, ignore malformed paths and remove only scoped tombstones", () => {
  S().hydrate({});
  const other = S().createSpace({ name: "Other" });
  useBrowser.setState({
    localFiles: {
      a: pin("a", 1, { kind: "folder", expanded: true }),
      b: pin("b", 0),
      kept: pin("kept", 0, { spaceId: other }),
    },
  });
  const incoming = new Map([
    ["file:a", { p: "/Users/owner/new", n: "New name", k: "folder", a: 100, pos: "V", bookmark: "secret" }],
    ["file:bad", { p: "../relative", n: "Bad", k: "file", a: 100, pos: "W" }],
  ]);
  localFilesAdapter("default").apply(incoming, new Set(["file:a", "file:b", "file:kept", "file:bad"]));
  assert.equal(S().localFiles.a.name, "New name");
  assert.equal(S().localFiles.a.expanded, true);
  assert.equal(S().localFiles.a.bookmark, undefined);
  assert.equal(S().localFiles.bad, undefined);
  assert.equal(S().localFiles.b, undefined);
  assert.equal(S().localFiles.kept.spaceId, other);
});

test("two Macs converge on file paths, order, rename and deletion without transferring grants", async () => {
  const files = new Map();
  let counter = 0;
  const transport = {
    write: async (_scope, payload) => {
      const id = `f${++counter}`;
      files.set(id, payload);
      return id;
    },
    read: async (_scope, known) => ({
      files: [...files].filter(([id]) => !known.includes(id)).map(([id, payload]) => ({ id, payload })),
      pending: [],
      damaged: [],
      present: [...files.keys()],
    }),
    remove: async (_scope, ids) => ids.forEach((id) => files.delete(id)),
  };
  const device = (id) => {
    S().hydrate({});
    return { id, browser: S(), state: emptyScope(), clock: new Clock(id) };
  };
  const a = device("a");
  const b = device("b");
  const edit = (device, fn) => {
    useBrowser.setState(device.browser, true);
    fn();
    device.browser = S();
  };
  const sync = async (device) => {
    useBrowser.setState(device.browser, true);
    await syncScope({ scope: "p", state: device.state, transport, adapters: [localFilesAdapter("default")], clock: device.clock, device: device.id });
    device.browser = S();
  };
  const converge = async () => {
    for (let i = 0; i < 2; i++) {
      await sync(a);
      await sync(b);
    }
  };
  edit(a, () => useBrowser.setState({ localFiles: { pdf: pin("pdf", 1), folder: pin("folder", 0, { kind: "folder", expanded: true }) } }));
  await converge();
  assert.equal(b.browser.localFiles.pdf.path, a.browser.localFiles.pdf.path);
  assert.equal(b.browser.localFiles.folder.expanded, false);
  assert.deepEqual(
    Object.values(b.browser.localFiles)
      .sort((x, y) => x.order - y.order)
      .map((x) => x.id),
    ["folder", "pdf"],
  );
  edit(b, () =>
    useBrowser.setState({ localFiles: { pdf: { ...S().localFiles.pdf, name: "Report", order: 0 }, folder: { ...S().localFiles.folder, order: 1 } } }),
  );
  await converge();
  assert.equal(a.browser.localFiles.pdf.name, "Report");
  assert.ok(a.browser.localFiles.pdf.order < a.browser.localFiles.folder.order);
  edit(a, () => useBrowser.setState({ localFiles: { pdf: S().localFiles.pdf } }));
  await converge();
  assert.equal(b.browser.localFiles.folder, undefined);
  assert.equal([...files.values()].join("").includes("bookmark"), false);
});

test("file sync mutates only its configured coordinator store", async () => {
  const { createBrowserStore } = await import("../store/browser.ts");
  const owner = createBrowserStore();
  const legacy = useBrowser.getState();
  const release = configureSyncStore(owner);
  try {
    localFilesAdapter("default").apply(
      new Map([["file:owner", { p: "/Documents/owner.pdf", n: "Owner", k: "file", a: 100, pos: "V" }]]),
      new Set(["file:owner"]),
    );
    assert.equal(owner.getState().localFiles.owner.name, "Owner");
    assert.strictEqual(useBrowser.getState(), legacy);
  } finally {
    release();
    configureSyncStore(useBrowser);
  }
});
