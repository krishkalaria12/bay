import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, emptyScope, syncScope } from "@bay/sync";
import { useBrowser } from "../store/browser.ts";
import { linkRulesAdapter, resolveLinkRuleSpaces } from "./linkRules.ts";

const { configureSyncStore } = await import("./store.ts");
configureSyncStore(useBrowser);
const S = () => useBrowser.getState();
const rule = (id, destination) => ({ id, pattern: `${id}.example/*`, destination });
const extract = (adapter) => adapter.extract(() => undefined);
const apply = (adapter, values) => adapter.apply(values, new Set(values.keys()), () => undefined);

function memoryTransport() {
  const files = new Map();
  let counter = 0;
  return {
    write: async (scope, payload) => {
      const id = `file-${++counter}`;
      files.set(id, { scope, payload });
      return id;
    },
    read: async (scope, known) => {
      const entries = [...files].filter(([, file]) => file.scope === scope);
      return {
        files: entries.filter(([id]) => !known.includes(id)).map(([id, file]) => ({ id, payload: file.payload })),
        pending: [],
        damaged: [],
        present: entries.map(([id]) => id),
      };
    },
    remove: async (_scope, ids) => ids.forEach((id) => files.delete(id)),
  };
}

class Device {
  links = {};
  state = emptyScope();
  constructor(id, transport) {
    this.id = id;
    this.transport = transport;
    this.clock = new Clock(id);
    this.adapter = linkRulesAdapter(() => this.links);
    S().hydrate({});
    this.browser = S();
  }
  with(fn) {
    useBrowser.setState(this.browser, true);
    try {
      return fn();
    } finally {
      this.browser = S();
    }
  }
  async sync() {
    useBrowser.setState(this.browser, true);
    try {
      return await syncScope({
        scope: "app",
        state: this.state,
        transport: this.transport,
        adapters: [this.adapter],
        clock: this.clock,
        device: this.id,
      });
    } finally {
      this.browser = S();
    }
  }
}

test("link rules sync priority with stable profile IDs across different local spaces", () => {
  S().hydrate({});
  const a = S().createSpace({ name: "Work A" });
  S().updateSettings({
    externalLinkRules: [
      { ...rule("work", { kind: "space", spaceId: a }), matchType: "equals", pattern: "https://work.example/report?view=board#today" },
      { ...rule("preview", { kind: "littleBay" }), matchType: "contains", pattern: "preview.example" },
      rule("window", { kind: "newWindow" }),
      { ...rule("recent", { kind: "mostRecentSpace" }), matchType: "contains", pattern: "recent.example" },
    ],
  });
  const adapterA = linkRulesAdapter(() => ({ [a]: { syncId: "shared-work" } }));
  const wire = extract(adapterA).values;
  assert.equal(wire.get("linkRules:ordered").rules[0].destination.profileId, "shared-work");
  assert.equal(JSON.stringify([...wire]).includes(a), false, "local space IDs never leave this Mac");

  S().hydrate({});
  const b = S().createSpace({ name: "Work B" });
  const adapterB = linkRulesAdapter(() => ({ [b]: { syncId: "shared-work" } }));
  apply(adapterB, wire);
  assert.deepEqual(
    S().settings.externalLinkRules.map((r) => r.id),
    ["work", "preview", "window", "recent"],
  );
  assert.deepEqual(S().settings.externalLinkRules[0].destination, { kind: "space", spaceId: b, syncProfileId: "shared-work" });
  assert.deepEqual(extract(adapterB).values, wire, "a receiver republishes the same stable values");
  S().updateSettings({ externalLinkRules: [...S().settings.externalLinkRules].reverse() });
  assert.deepEqual(
    extract(adapterB)
      .values.get("linkRules:ordered")
      .rules.map((r) => r.id),
    ["recent", "window", "preview", "work"],
  );
});

test("unresolved rules survive unchanged until their profile is linked; malformed lists do not replace them", () => {
  S().hydrate({});
  const links = {};
  const adapter = linkRulesAdapter(() => links);
  const wire = new Map([["linkRules:ordered", { rules: [rule("work", { kind: "space", profileId: "remote-work" }), rule("window", { kind: "newWindow" })] }]]);
  apply(adapter, wire);
  assert.deepEqual(S().settings.externalLinkRules[0].destination, { kind: "space", spaceId: "sync-profile:remote-work", syncProfileId: "remote-work" });
  assert.deepEqual(extract(adapter).values, wire, "unresolved destinations retain priority and stable target");
  const local = S().createSpace({ name: "Linked later" });
  links[local] = { syncId: "remote-work" };
  resolveLinkRuleSpaces(links);
  assert.equal(S().settings.externalLinkRules[0].destination.spaceId, local);
  const current = S().settings.externalLinkRules;
  for (const rules of [null, [null], [{ ...rule("bad", { kind: "space" }), pattern: "bad.example" }], [rule("bad", { kind: "unknown" })]]) {
    apply(adapter, new Map([["linkRules:ordered", { rules }]]));
    assert.deepEqual(S().settings.externalLinkRules, current);
  }
  S().updateSettings({ externalLinkRules: [rule("deleted", { kind: "space", spaceId: "never-synced-deleted-space" }), ...current] });
  resolveLinkRuleSpaces(links);
  const deleted = extract(adapter).values.get("linkRules:ordered").rules[0];
  assert.deepEqual(deleted.destination, { kind: "space", profileId: "unlinked-rule:deleted" }, "a deleted never-synced space cannot block the remaining rules");
  assert.equal(S().settings.externalLinkRules.length, 3);
});

test("a new local space waits for a stable profile link before rules publish and deleting it publishes removal", async () => {
  S().hydrate({});
  const id = S().createSpace({ name: "New" });
  S().updateSettings({ externalLinkRules: [rule("new", { kind: "space", spaceId: id })] });
  const links = {};
  const adapter = linkRulesAdapter(() => links);
  assert.equal(extract(adapter), null);
  links[id] = { syncId: "new-profile" };
  resolveLinkRuleSpaces(links);
  assert.equal(S().settings.externalLinkRules[0].destination.syncProfileId, "new-profile");
  assert.equal(extract(adapter).values.get("linkRules:ordered").rules[0].destination.profileId, "new-profile");
  delete links[id];
  resolveLinkRuleSpaces(links);
  assert.equal(S().settings.externalLinkRules[0].destination.spaceId, id, "starting a new chain keeps the existing local destination");
  assert.equal(extract(adapter), null);
  links[id] = { syncId: "replacement-profile" };
  resolveLinkRuleSpaces(links);
  assert.equal(S().settings.externalLinkRules[0].destination.syncProfileId, "replacement-profile");
  S().updateSettings({
    externalLinkRules: [
      rule("window", { kind: "newWindow" }),
      ...S().settings.externalLinkRules,
      rule("unresolved", { kind: "space", spaceId: "sync-profile:remote-profile", syncProfileId: "remote-profile" }),
      rule("preview", { kind: "littleBay" }),
    ],
  });
  const state = emptyScope();
  const transport = memoryTransport();
  const clock = new Clock("local");
  const sync = () => syncScope({ scope: "app", state, transport, clock, device: "local", adapters: [adapter] });
  await sync();
  assert.equal((await sync()).published, 1);
  S().deleteSpace(id);
  resolveLinkRuleSpaces(links);
  assert.equal((await sync()).published, 1, "local space deletion publishes the changed ordered list");
  const published = state.records["linkRules:ordered"].v.rules;
  assert.deepEqual(
    published.map((r) => r.id),
    ["window", "unresolved", "preview"],
    "deleting a linked local space removes its rule and keeps priority",
  );
  assert.deepEqual(published[1].destination, { kind: "space", profileId: "remote-profile" }, "an unresolved remote rule survives local space deletion");
  const remote = S().createSpace({ name: "Remote" });
  links[remote] = { syncId: "remote-profile" };
  resolveLinkRuleSpaces(links);
  assert.equal(S().settings.externalLinkRules[1].destination.spaceId, remote);
  assert.deepEqual(extract(adapter).values.get("linkRules:ordered").rules, published, "linking the unresolved destination does not change the published list");
});

test("syncScope retries remote apply without erasing unpublished local edits before profile linking", async () => {
  const transport = memoryTransport();
  const remote = new Device("remote", transport);
  remote.with(() => S().updateSettings({ externalLinkRules: [rule("window", { kind: "newWindow" }), rule("preview", { kind: "littleBay" })] }));
  await remote.sync();
  await remote.sync();
  const local = new Device("local", transport);
  await local.sync();
  const base = local.state.base["linkRules:ordered"];
  const spaceId = local.with(() => {
    const id = S().createSpace({ name: "Not linked yet" });
    S().updateSettings({
      externalLinkRules: [
        rule("new", { kind: "space", spaceId: id }),
        rule("preview", { kind: "littleBay" }),
        { ...rule("window", { kind: "newWindow" }), pattern: "edited.example/*" },
      ],
    });
    return id;
  });
  const edits = local.with(() => S().settings.externalLinkRules);
  remote.with(() => S().updateSettings({ externalLinkRules: [rule("remote-edit", { kind: "newWindow" })] }));
  await remote.sync();

  assert.equal((await local.sync()).published, 0);
  assert.deepEqual(
    local.with(() => S().settings.externalLinkRules),
    edits,
    "the incoming list cannot erase an unpublishable local edit",
  );
  assert.equal(local.state.base["linkRules:ordered"], base, "deferred apply does not acknowledge the incoming value");
  assert.deepEqual(local.state.unapplied, ["linkRules:ordered"]);
  const retry = await local.sync();
  assert.equal(retry.changed, 0, "no new transport records are needed for a retry");
  assert.equal(retry.published, 0);
  assert.deepEqual(local.state.unapplied, ["linkRules:ordered"]);
  assert.deepEqual(
    local.with(() => S().settings.externalLinkRules),
    edits,
  );

  local.links[spaceId] = { syncId: "new-profile" };
  local.with(() => resolveLinkRuleSpaces(local.links));
  assert.equal((await local.sync()).published, 1, "linking lets local edits participate before retrying remote apply");
  assert.deepEqual(local.state.unapplied, []);
  await remote.sync();
  const published = local.state.records["linkRules:ordered"].v.rules;
  assert.deepEqual(
    published.map((r) => r.id),
    ["new", "preview", "window"],
  );
  assert.deepEqual(published[0].destination, { kind: "space", profileId: "new-profile" });
  assert.equal(published[2].pattern, "edited.example/*");
  assert.deepEqual(
    remote.with(() => extract(remote.adapter).values),
    local.with(() => extract(local.adapter).values),
  );
  assert.equal((await local.sync()).published, 0, "the devices settle after linking");
});

test("syncScope intentionally adopts the remote ordered list on an initial join", async () => {
  const transport = memoryTransport();
  const remote = new Device("remote", transport);
  remote.with(() => S().updateSettings({ externalLinkRules: [rule("remote", { kind: "newWindow" })] }));
  await remote.sync();
  await remote.sync();
  const local = new Device("local", transport);
  local.with(() => {
    const spaceId = S().createSpace({ name: "Already linked" });
    local.links[spaceId] = { syncId: "local-profile" };
    S().updateSettings({ externalLinkRules: [rule("local", { kind: "space", spaceId })] });
  });
  assert.equal((await local.sync()).published, 0, "a publishable local list does not override the chain on join");
  assert.deepEqual(
    local.with(() => S().settings.externalLinkRules.map((r) => r.id)),
    ["remote"],
  );
  assert.equal((await local.sync()).published, 0);
});

test("an initial join with an unlinked local destination defers adoption until local edits can publish", async () => {
  const transport = memoryTransport();
  const remote = new Device("remote", transport);
  remote.with(() => S().updateSettings({ externalLinkRules: [rule("remote", { kind: "newWindow" })] }));
  await remote.sync();
  await remote.sync();
  const local = new Device("local", transport);
  const spaceId = local.with(() => {
    const id = S().createSpace({ name: "Not linked yet" });
    S().updateSettings({ externalLinkRules: [rule("local", { kind: "space", spaceId: id })] });
    return id;
  });
  assert.equal((await local.sync()).published, 0);
  assert.equal(local.state.joined, true);
  assert.deepEqual(local.state.unapplied, ["linkRules:ordered"]);
  assert.deepEqual(
    local.with(() => S().settings.externalLinkRules.map((r) => r.id)),
    ["local"],
  );

  local.links[spaceId] = { syncId: "local-profile" };
  local.with(() => resolveLinkRuleSpaces(local.links));
  assert.equal((await local.sync()).published, 1, "after a deferred join, local edits participate once linked");
  assert.deepEqual(local.state.unapplied, []);
  await remote.sync();
  assert.deepEqual(
    remote.with(() => S().settings.externalLinkRules.map((r) => r.id)),
    ["local"],
  );
});
