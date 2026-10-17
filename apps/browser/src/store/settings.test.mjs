import test from "node:test";
import assert from "node:assert/strict";
import { restoreSettings } from "./settings.ts";

test("Harbor keeps preferences and custom shortcuts from existing profiles", () => {
  const settings = restoreSettings({ openLinksInSmallYahu: false, smallYahuSize: [1000, 720], shortcuts: { newSmallYahu: ["n", "command", "option"] } });
  assert.equal(settings.openLinksInHarbor, false);
  assert.deepEqual(settings.harborSize, [1000, 720]);
  assert.deepEqual(settings.shortcuts.newHarbor, ["n", "command", "option"]);
  assert.equal("smallYahuSize" in settings, false);
  assert.equal("newSmallYahu" in settings.shortcuts, false);
});
test("Harbor preferences take precedence and invalid legacy sizes use defaults", () => {
  const settings = restoreSettings({ openLinksInHarbor: true, openLinksInSmallYahu: false, harborSize: [800, 600], smallYahuSize: [1000, 720] });
  assert.equal(settings.openLinksInHarbor, true);
  assert.deepEqual(settings.harborSize, [800, 600]);
  assert.deepEqual(restoreSettings({ smallYahuSize: [-1, NaN] }).harborSize, [900, 640]);
});

test("a session without settings restores desktop defaults", () => {
  assert.equal(restoreSettings(null).openLinksInHarbor, true);
  assert.deepEqual(restoreSettings().harborSize, [900, 640]);
});
