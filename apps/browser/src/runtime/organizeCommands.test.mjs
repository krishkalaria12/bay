import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore } from "../store/browser.ts";
import { activeTabId } from "../store/model.ts";
import { createBrowserAuthority } from "./authority.ts";
import { executeOrganizeCommand, ORGANIZE_COMMAND_METHODS, parseOrganizeCommand } from "./organizeCommands.ts";
import { browserCommandResultKind } from "./userCommands.ts";

const run = (store, command) => executeOrganizeCommand(store, parseOrganizeCommand(command));
function setup() {
  const store = createBrowserStore();
  const windowId = store.getState().createWindow({ url: "a.com" });
  const s = () => store.getState();
  const a = activeTabId(s(), windowId);
  const b = s().newTab(windowId, { url: "b.com", background: true });
  const c = s().newTab(windowId, { url: "c.com", background: true });
  const privateWindow = s().createWindow({ incognito: true, url: "private.com" });
  const privateTab = activeTabId(s(), privateWindow);
  return { store, s, windowId, a, b, c, privateWindow, privateTab };
}

test("organize parser closes every command and nested option object", () => {
  const commands = [
    { method: "createGroup", tabIds: ["t"], options: { name: "n", icon: null, color: "blue" } },
    { method: "groupTabs", tabIds: ["t"], options: { pinned: false, name: "" } },
    { method: "updateGroup", groupId: "g", patch: { name: "n", icon: "★", color: null, collapsed: true, pinned: false } },
    { method: "addTabsToGroup", groupId: "g", tabIds: ["t"] },
    { method: "removeTabsFromGroup", tabIds: ["t"] },
    ...["ungroup", "closeGroup", "deleteGroup", "duplicateGroup", "moveGroupToBookmarksBar"].map((method) => ({ method, groupId: "g" })),
    { method: "moveGroup", groupId: "g", placement: { pinned: true, beforeId: null } },
    { method: "newTabInGroup", groupId: "g", url: "x.com" },
    { method: "newPinnedFolder", windowId: "w", options: { tabIds: ["t"], name: "n", parentId: "f", spaceId: "s", beforeId: "b" } },
    { method: "updatePinnedFolder", folderId: "f", patch: { name: "n", icon: null, collapsed: false } },
    { method: "movePinnedFolder", folderId: "f", beforeId: null, parentId: null },
    { method: "deletePinnedFolder", folderId: "f" },
    { method: "undoPinnedFolderMove" },
    { method: "setSelection", windowId: "w", tabIds: [] },
    { method: "placeTabs", tabIds: ["t"], placement: { pinned: false, row: true, folderId: null, beforeId: "b", groupId: null } },
    { method: "pinTabs", tabIds: ["t"], pinned: true },
    { method: "pinRows", tabIds: ["t"], pinned: false },
    { method: "setMuted", tabIds: ["t"], muted: true },
    { method: "setSiteMuted", tabId: "t", muted: false },
    { method: "returnToPinnedUrl", tabId: "t" },
    { method: "setPinnedUrl", tabId: "t", url: "x.com" },
    { method: "cleanUpTabs", windowId: "w", options: { inactiveForMs: 0, spaceId: "s" } },
    { method: "restoreCleaned", windowId: "w", entryId: "e" },
  ];
  assert.deepEqual(new Set(commands.map((c) => c.method)), new Set(ORGANIZE_COMMAND_METHODS));
  for (const command of commands) {
    const parsed = parseOrganizeCommand(command);
    assert.deepEqual(parsed, command);
    assert.notEqual(parsed, command);
    assert.throws(() => parseOrganizeCommand({ ...command, native: true }), { code: "invalid_request" });
    for (const key of ["options", "patch", "placement"])
      if (command[key]) assert.throws(() => parseOrganizeCommand({ ...command, [key]: { ...command[key], forged: 1 } }), { code: "invalid_request" });
  }
  for (const command of [
    { method: "cleanUpInactiveTabs" },
    { method: "closeAbandonedNewTabs" },
    { method: "createGroup", tabIds: ["t", "t"] },
    { method: "createGroup", tabIds: ["t"], options: { color: "magenta" } },
    { method: "updateGroup", groupId: "g", patch: { tabIds: [] } },
    { method: "updateGroup", groupId: "g", patch: { spaceId: "other" } },
    { method: "moveGroup", groupId: "g", placement: {} },
    { method: "movePinnedFolder", folderId: "f" },
    { method: "placeTabs", tabIds: ["t"], placement: { pinned: "yes" } },
    { method: "cleanUpTabs", windowId: "w", options: { inactiveForMs: -1 } },
    { method: "setMuted", tabIds: ["t"], muted: 1 },
  ])
    assert.throws(() => parseOrganizeCommand(command), { code: "invalid_request" }, JSON.stringify(command));
});

test("organize commands run group, folder, placement and cleanup reducers", () => {
  const { store, s, windowId, a, b, c } = setup();
  const members = (id) => [...s().groups[id].tabIds].sort();
  const group = run(store, { method: "createGroup", tabIds: [a, b], options: { name: "Work" } });
  assert.deepEqual(members(group), [a, b].sort());
  run(store, { method: "updateGroup", groupId: group, patch: { color: "green", collapsed: true } });
  assert.equal(s().groups[group].color, "green");
  run(store, { method: "addTabsToGroup", groupId: group, tabIds: [c] });
  assert.deepEqual(members(group), [a, b, c].sort());
  run(store, { method: "removeTabsFromGroup", tabIds: [c] });
  assert.deepEqual(members(group), [a, b].sort());
  const copy = run(store, { method: "duplicateGroup", groupId: group });
  assert.equal(s().groups[copy].tabIds.length, 2);
  const inGroup = run(store, { method: "newTabInGroup", groupId: copy, url: "d.com" });
  assert.ok(s().groups[copy].tabIds.includes(inGroup));
  run(store, { method: "deleteGroup", groupId: copy });
  assert.equal(s().groups[copy], undefined);
  run(store, { method: "ungroup", groupId: group });
  assert.equal(s().groups[group], undefined);

  run(store, { method: "pinRows", tabIds: [b], pinned: true });
  assert.equal(s().tabs[b].pinnedRow, true);
  const folder = run(store, { method: "newPinnedFolder", windowId, options: { tabIds: [b], name: "Docs" } });
  assert.equal(s().tabs[b].folderId, folder);
  run(store, { method: "updatePinnedFolder", folderId: folder, patch: { name: "Notes" } });
  assert.equal(s().pinnedFolders[folder].name, "Notes");
  const child = run(store, { method: "newPinnedFolder", windowId, options: { name: "Child" } });
  run(store, { method: "movePinnedFolder", folderId: child, beforeId: null, parentId: folder });
  assert.equal(s().pinnedFolders[child].parentId, folder);
  run(store, { method: "undoPinnedFolderMove" });
  assert.equal(s().pinnedFolders[child].parentId, undefined);
  run(store, { method: "deletePinnedFolder", folderId: folder });
  assert.equal(s().pinnedFolders[folder], undefined);

  run(store, { method: "pinTabs", tabIds: [c], pinned: true });
  assert.equal(s().tabs[c].pinned, true);
  run(store, { method: "placeTabs", tabIds: [c], placement: { pinned: false } });
  assert.equal(s().tabs[c].pinned, false);
  run(store, { method: "setMuted", tabIds: [a, c], muted: true });
  assert.equal(s().tabs[a].muted && s().tabs[c].muted, true);
  run(store, { method: "setSiteMuted", tabId: a, muted: true });
  assert.ok(s().settings.mutedSites.includes("a.com"));
  run(store, { method: "setSelection", windowId, tabIds: [a, c] });
  assert.deepEqual(s().selection[windowId], [a, c]);

  run(store, { method: "cleanUpTabs", windowId, options: { inactiveForMs: 0 } });
  const entry = s().cleanedTabs.at(-1);
  assert.ok(entry);
  const restored = run(store, { method: "restoreCleaned", windowId, entryId: entry.id });
  assert.equal(s().tabs[restored].url, entry.tab.url);
  assert.equal(browserCommandResultKind("restoreCleaned"), "optionalId");
  for (const method of ["createGroup", "groupTabs", "duplicateGroup", "newTabInGroup", "newPinnedFolder"]) assert.equal(browserCommandResultKind(method), "id");
});

test("organize commands reject references across private and space boundaries without mutating", () => {
  const { store, s, windowId, a, b, privateWindow, privateTab } = setup();
  const other = s().createSpace({ name: "Other" });
  const foreign = s().newTab(windowId, { spaceId: other, url: "f.com", background: true });
  const group = s().createGroup([a]);
  const privateGroup = s().createGroup([privateTab]);
  s().pinRows([b], true);
  const folder = s().newPinnedFolder(windowId, { tabIds: [b] });
  s().newTab(privateWindow, { url: "hidden.com", background: true });
  s().cleanUpTabs(privateWindow, { inactiveForMs: 0 });
  const privateEntry = s().privateCleanedTabs[privateWindow]?.at(-1);
  assert.ok(privateEntry);
  for (const command of [
    { method: "createGroup", tabIds: [a, privateTab] },
    { method: "groupTabs", tabIds: ["missing"] },
    { method: "addTabsToGroup", groupId: group, tabIds: [privateTab] },
    { method: "addTabsToGroup", groupId: group, tabIds: [foreign] },
    { method: "addTabsToGroup", groupId: "missing", tabIds: [a] },
    { method: "moveGroup", groupId: group, placement: { pinned: false, beforeId: foreign } },
    { method: "placeTabs", tabIds: [a], placement: { pinned: false, groupId: privateGroup } },
    { method: "placeTabs", tabIds: [foreign], placement: { pinned: false, row: true, folderId: folder } },
    { method: "placeTabs", tabIds: [a], placement: { pinned: false, beforeId: privateTab } },
    { method: "newPinnedFolder", windowId: privateWindow },
    { method: "newPinnedFolder", windowId, options: { tabIds: [foreign] } },
    { method: "newPinnedFolder", windowId, options: { spaceId: s().windows[privateWindow].spaceId } },
    { method: "movePinnedFolder", folderId: folder, beforeId: foreign },
    { method: "setSelection", windowId, tabIds: [privateTab] },
    { method: "setSelection", windowId: privateWindow, tabIds: [a] },
    { method: "setMuted", tabIds: [a, privateTab], muted: true },
    { method: "cleanUpTabs", windowId: privateWindow, options: { spaceId: other } },
    { method: "restoreCleaned", windowId, entryId: privateEntry.id },
    { method: "restoreCleaned", windowId: privateWindow, entryId: "missing" },
  ]) {
    const before = s();
    assert.throws(() => run(store, command), { code: "invalid_request" }, JSON.stringify(command));
    assert.equal(s(), before, JSON.stringify(command));
  }
  assert.ok(run(store, { method: "restoreCleaned", windowId: privateWindow, entryId: privateEntry.id }));
});

test("group ids are never empty acknowledgements", async () => {
  const { store, a } = setup();
  const authority = createBrowserAuthority({ epoch: "organize", store });
  // A pinned tab cannot join a group, so the reducer returns no group.
  store.getState().togglePin(a);
  await assert.rejects(authority.dispatch({ epoch: "organize", clientId: "w", requestId: 1, command: { method: "createGroup", tabIds: [a] } }), {
    code: "invalid_request",
  });
  assert.deepEqual(authority.getSnapshot().state.groups, {});
  authority.close();
});
