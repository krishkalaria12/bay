// The phone's sync (src/sync) against a stand-in computer on one chain: the computer's records reach the phone's
// store as tabs to open, bookmarks (its bar a folder) and history, and the phone's own go the other way, in the shapes
// the computer reads (apps/browser/src/sync/adapters.ts).
import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "@bay/sync/src/canon.ts";
import { Clock } from "@bay/sync/src/hlc.ts";
import { emptyScope, syncScope, visible, type Listing, type ScopeState, type Transport } from "@bay/sync/src/scope.ts";

import { SYNC_BAR } from "../src/sync/adapters.ts";
import { newDoc, remoteTabs, runCycle, syncedDevices, type SyncDoc } from "../src/sync/engine.ts";
import { BOOKMARKS_ROOT } from "../src/store/bookmarks.ts";
import { createTab, HISTORY_LIMIT, initialBrowserData, reduceBrowserData, type BrowserAction } from "../src/store/model.ts";
import type { BrowserData } from "../src/store/types.ts";

const NOW = Date.UTC(2026, 10, 16, 12);

/** One chain's files in memory, as the relay keeps them. */
function chain(): Transport {
  const files = new Map<string, string>();
  let counter = 0;

  return {
    write: async (scope, payload) => {
      const id = `f${++counter}`;

      files.set(`${scope}/${id}`, payload);

      return id;
    },
    read: async (scope, known): Promise<Listing> => {
      const listing: Listing = { files: [], pending: [], damaged: [], present: [] };

      for (const [name, payload] of files) {
        if (!name.startsWith(`${scope}/`)) continue;

        const id = name.slice(scope.length + 1);

        listing.present.push(id);

        if (!known.includes(id)) listing.files.push({ id, payload });
      }

      return listing;
    },
    remove: async (scope, ids) => {
      for (const id of ids) files.delete(`${scope}/${id}`);
    },
  };
}

/** The computer: fixed records in each scope, and what it reads back. */
function computer(transport: Transport) {
  const scopes: Record<string, ScopeState> = {};
  const clock = new Clock("mac", null, () => NOW);

  const records = {
    app: new Map<string, JsonValue>([
      ["dev:mac", { n: "Krish's MacBook" }],
      ["prof:personal", { n: "Personal", c: "blue", i: null, d: true }],
    ]),
    "p:personal": new Map<string, JsonValue>([
      ["tabs:mac", { n: "Krish's MacBook", tabs: [{ u: "https://bay.example/", t: "Bay" }] }],
      ["bm:folder-1", { k: "f", p: "bar", t: "Work", a: 1, pos: "V" }],
      ["bm:link-1", { k: "u", p: "folder-1", t: "Docs", u: "https://docs.example/", a: 2, pos: "V" }],
      ["bm:link-2", { k: "u", p: "other", t: "News", u: "https://news.example/", a: 3, pos: "V" }],
      ["h:https://visited.example/", { t: "Visited", n: 3, vt: [NOW - 60_000] }],
    ]),
  } satisfies Record<string, Map<string, JsonValue>>;

  const sync = async () => {
    for (const scope of ["app", "p:personal"] as const) {
      const values = records[scope];

      await syncScope({
        scope,
        state: (scopes[scope] ??= emptyScope()),
        transport,
        clock,
        device: "mac",
        now: () => NOW,
        adapters: [...new Set([...values.keys()].map((key) => key.slice(0, key.indexOf(":") + 1)))].map((prefix) => ({
          prefix,
          extract: () => ({ values: new Map([...values].filter(([key]) => key.startsWith(prefix))), ignore: (key: string) => !values.has(key) }),
          apply: () => true,
        })),
      });
    }
  };

  return { sync, seen: (scope: string, prefix: string) => visible(scopes[scope]!, prefix) };
}

/** The phone: its store, and the cycle's other needs. */
function phone(transport: Transport) {
  let data: BrowserData = initialBrowserData({ ...createTab("phone-tab", NOW), url: "https://phone.example/", title: "On the phone" });
  const doc: SyncDoc = newDoc("phone");

  data = reduceBrowserData(data, { type: "visit", url: "https://phone.example/", title: "On the phone", favicon: null, now: NOW - 1000 });

  const cycle = () =>
    runCycle(doc, {
      transport,
      deviceName: () => "Krish's iPhone",
      data: () => data,
      ready: () => true,
      dispatch: (action: BrowserAction) => void (data = reduceBrowserData(data, action)),
      barTitle: () => "Bookmarks bar",
      historyLimit: HISTORY_LIMIT,
      save: async () => undefined,
      now: () => NOW,
    });

  return { doc, cycle, data: () => data };
}

test("a phone and a computer sync devices, tabs, bookmarks and history both ways", async () => {
  const transport = chain();
  const mac = computer(transport);
  const iphone = phone(transport);

  await mac.sync();
  await iphone.cycle();
  await iphone.cycle();
  await mac.sync();

  // The computer's default profile is the one the phone syncs with.
  assert.equal(iphone.doc.profile, "personal");
  assert.deepEqual(
    syncedDevices(iphone.doc).map((device) => [device.name, device.current]),
    [
      ["Krish's iPhone", true],
      ["Krish's MacBook", false],
    ],
  );

  // The computer's tabs, to open on the phone.
  assert.deepEqual(remoteTabs(iphone.doc), [{ deviceId: "mac", name: "Krish's MacBook", tabs: [{ u: "https://bay.example/", t: "Bay" }] }]);

  // Its bar is a folder at the top of the phone's tree; its other bookmarks are the tree.
  const bookmarks = iphone.data().bookmarks;

  assert.deepEqual(bookmarks[BOOKMARKS_ROOT]?.kind === "folder" && bookmarks[BOOKMARKS_ROOT].children, [SYNC_BAR, "link-2"]);
  assert.deepEqual(bookmarks[SYNC_BAR]?.kind === "folder" && bookmarks[SYNC_BAR].children, ["folder-1"]);
  assert.deepEqual(bookmarks["link-1"], { kind: "url", id: "link-1", parentId: "folder-1", title: "Docs", url: "https://docs.example/", addedAt: 2 });

  // Its history is in the phone's, with its visits.
  const visited = iphone.data().history.find((entry) => entry.url === "https://visited.example/");

  assert.equal(visited?.visits, 3);
  assert.equal(visited?.lastVisit, NOW - 60_000);

  // The computer reads the phone's name, tabs and history in its own shapes.
  assert.deepEqual(Object.fromEntries(mac.seen("app", "dev:")), { "dev:mac": { n: "Krish's MacBook" }, "dev:phone": { n: "Krish's iPhone" } });
  assert.deepEqual(mac.seen("p:personal", "tabs:").get("tabs:phone"), { n: "Krish's iPhone", tabs: [{ u: "https://phone.example/", t: "On the phone" }] });
  assert.deepEqual(mac.seen("p:personal", "h:").get("h:https://phone.example/"), { t: "On the phone", n: 1, vt: [NOW - 1000] });
});

test("a phone leaving the chain takes its name and tabs with it", async () => {
  const transport = chain();
  const mac = computer(transport);
  const iphone = phone(transport);

  await mac.sync();
  await iphone.cycle();
  await iphone.cycle();
  await runCycle(
    iphone.doc,
    {
      transport,
      deviceName: () => "Krish's iPhone",
      data: iphone.data,
      ready: () => true,
      dispatch: () => undefined,
      barTitle: () => "Bookmarks bar",
      historyLimit: HISTORY_LIMIT,
      save: async () => undefined,
      now: () => NOW,
    },
    true,
  );
  await mac.sync();

  assert.equal(mac.seen("app", "dev:").has("dev:phone"), false);
  assert.equal(mac.seen("p:personal", "tabs:").has("tabs:phone"), false);
});
