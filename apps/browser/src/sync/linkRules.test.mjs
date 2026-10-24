import assert from "node:assert/strict";
import { test } from "node:test";
import { useBrowser } from "../store/browser.ts";
import { linkRulesAdapter, resolveLinkRuleSpaces } from "./linkRules.ts";

const { configureSyncStore } = await import("./store.ts");
configureSyncStore(useBrowser);
const S = () => useBrowser.getState();
const rule = (id, destination) => ({ id, pattern: `${id}.example/*`, destination });
const extract = (adapter) => adapter.extract(() => undefined);
const apply = (adapter, values) => adapter.apply(values, new Set(values.keys()), () => undefined);

test("link rules sync priority with stable profile IDs across different local spaces", () => {
  S().hydrate({});
  const a = S().createSpace({ name: "Work A" });
  S().updateSettings({
    externalLinkRules: [rule("work", { kind: "space", spaceId: a }), rule("preview", { kind: "littleBay" }), rule("window", { kind: "newWindow" })],
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
    ["work", "preview", "window"],
  );
  assert.deepEqual(S().settings.externalLinkRules[0].destination, { kind: "space", spaceId: b, syncProfileId: "shared-work" });
  assert.deepEqual(extract(adapterB).values, wire, "a receiver republishes the same stable values");
  S().updateSettings({ externalLinkRules: [...S().settings.externalLinkRules].reverse() });
  assert.deepEqual(
    extract(adapterB)
      .values.get("linkRules:ordered")
      .rules.map((r) => r.id),
    ["window", "preview", "work"],
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

test("a new local space waits for a stable profile link before rules publish", () => {
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
  S().deleteSpace(id);
  resolveLinkRuleSpaces(links);
  assert.equal(S().settings.externalLinkRules[0].destination.spaceId, "sync-profile:replacement-profile");
  assert.equal(extract(adapter).values.get("linkRules:ordered").rules[0].destination.profileId, "replacement-profile");
});
