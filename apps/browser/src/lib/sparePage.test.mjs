import assert from "node:assert/strict";
import { test } from "node:test";
import { useKillSwitches } from "./killSwitches.ts";
import { WARM_EVERY_MS, warmSparePage } from "./sparePage.ts";
import { engineProfile } from "../store/model.ts";

test("the spare page warms once every few seconds per profile, never for a private window or once switched off", () => {
  const warmed = [];
  const warm = async (profile) => (warmed.push(profile), { warmed: true });

  assert.equal(warmSparePage("space-a", warm, 1_000), true);
  assert.equal(warmSparePage("space-a", warm, 1_000 + WARM_EVERY_MS - 1), false);
  assert.equal(warmSparePage("space-b", warm, 2_000), true);
  assert.equal(warmSparePage("space-a", warm, 1_000 + WARM_EVERY_MS), true);
  assert.deepEqual(warmed, [engineProfile("space-a"), engineProfile("space-b"), engineProfile("space-a")]);
  assert.equal(warmSparePage("incognito:1", warm, 50_000), false);
  useKillSwitches.setState({ active: [{ id: "x", feature: "sparePage", reason: "Crashes." }], checkedAt: 0 });
  assert.equal(warmSparePage("space-c", warm, 60_000), false);
  useKillSwitches.setState({ active: [], checkedAt: null });
});
