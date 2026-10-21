import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore } from "../store/browser.ts";
import { executeSpaceCommand, parseSpaceCommand, SPACE_COMMAND_METHODS } from "./spaceCommands.ts";
import { browserCommandResultKind } from "./userCommands.ts";

const run = (store, command) => executeSpaceCommand(store, parseSpaceCommand(command));
const theme = { colors: ["#7F5AF0", "#E84393"], intensity: 0.5, grain: 0.2 };

test("space parser closes every command and its options and patch", () => {
  const commands = [
    { method: "createSpace", options: { name: "Work", color: "blue", theme, icon: "💼", shareWith: null } },
    {
      method: "updateSpace",
      spaceId: "s",
      patch: { name: "n", color: "plum", icon: null, theme: null, followSite: true, folded: false, cleanUpAfterHours: "app" },
    },
    { method: "deleteSpace", spaceId: "s" },
    { method: "setDefaultSpace", spaceId: "s" },
    { method: "reorderSpaces", spaceIds: ["a", "b"] },
  ];
  assert.deepEqual(new Set(commands.map((c) => c.method)), new Set(SPACE_COMMAND_METHODS));
  for (const command of commands) {
    const parsed = parseSpaceCommand(command);
    assert.deepEqual(parsed, command);
    assert.notEqual(parsed, command);
    assert.throws(() => parseSpaceCommand({ ...command, native: true }), { code: "invalid_request" });
    for (const key of ["options", "patch"])
      if (command[key]) assert.throws(() => parseSpaceCommand({ ...command, [key]: { ...command[key], profileId: "x" } }), { code: "invalid_request" });
  }
  for (const command of [
    { method: "profileDataDeleted", engineId: "e" },
    { method: "createSpace", options: {} },
    { method: "createSpace", options: { name: "n", color: "magenta" } },
    { method: "updateSpace", spaceId: "s", patch: { theme: { colors: [], intensity: 0.5, grain: 0 } } },
    { method: "updateSpace", spaceId: "s", patch: { theme: { colors: ["red"], intensity: 0.5, grain: 0 } } },
    { method: "updateSpace", spaceId: "s", patch: { theme: { ...theme, intensity: 2 } } },
    { method: "updateSpace", spaceId: "s", patch: { cleanUpAfterHours: 0 } },
    { method: "updateSpace", spaceId: "s", patch: { cleanUpAfterHours: "never" } },
    { method: "reorderSpaces", spaceIds: ["a", "a"] },
  ])
    assert.throws(() => parseSpaceCommand(command), { code: "invalid_request" }, JSON.stringify(command));
  assert.equal(browserCommandResultKind("createSpace"), "id");
});

test("space commands create, update, reorder, default and delete spaces", () => {
  const store = createBrowserStore();
  const s = () => store.getState();
  const windowId = s().createWindow({ url: "a.com" });
  const work = run(store, { method: "createSpace", options: { name: "Work", color: "green", icon: "💼" } });
  assert.equal(s().spaces[work].name, "Work");
  const shared = run(store, { method: "createSpace", options: { name: "Shared", shareWith: work } });
  assert.equal(s().spaces[shared].sharesSignIns, true);

  run(store, { method: "updateSpace", spaceId: work, patch: { name: "Office", theme, cleanUpAfterHours: 12 } });
  assert.equal(s().spaces[work].name, "Office");
  assert.deepEqual(s().spaces[work].theme, theme);
  assert.equal(s().spaces[work].cleanUpAfterHours, 12);
  run(store, { method: "updateSpace", spaceId: work, patch: { cleanUpAfterHours: null } });
  assert.equal(s().spaces[work].cleanUpAfterHours, null);
  run(store, { method: "updateSpace", spaceId: work, patch: { cleanUpAfterHours: "app" } });
  assert.equal(s().spaces[work].cleanUpAfterHours, undefined, "the space follows the app's setting again");

  run(store, { method: "reorderSpaces", spaceIds: [shared, work] });
  assert.deepEqual(s().spaceOrder.slice(0, 2), [shared, work]);
  run(store, { method: "setDefaultSpace", spaceId: work });
  assert.equal(s().settings.defaultSpaceId, work);
  s().switchSpace(windowId, work);
  run(store, { method: "deleteSpace", spaceId: work });
  assert.equal(s().spaces[work], undefined);
  assert.notEqual(s().windows[windowId].spaceId, work);
});

test("space commands reject private, missing and last spaces without mutating", () => {
  const store = createBrowserStore();
  const s = () => store.getState();
  const privateWindow = s().createWindow({ incognito: true });
  const privateSpace = s().windows[privateWindow].spaceId;
  const only = s().spaceOrder[0];
  for (const command of [
    { method: "createSpace", options: { name: "n", shareWith: privateSpace } },
    { method: "createSpace", options: { name: "n", shareWith: "missing" } },
    { method: "updateSpace", spaceId: privateSpace, patch: { name: "n" } },
    { method: "updateSpace", spaceId: "missing", patch: { name: "n" } },
    { method: "deleteSpace", spaceId: only },
    { method: "setDefaultSpace", spaceId: privateSpace },
    { method: "reorderSpaces", spaceIds: [only, "missing"] },
  ]) {
    const before = s();
    assert.throws(() => run(store, command), { code: "invalid_request" }, JSON.stringify(command));
    assert.equal(s(), before, JSON.stringify(command));
  }
});
