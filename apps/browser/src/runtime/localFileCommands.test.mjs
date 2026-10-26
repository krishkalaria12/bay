import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore } from "../store/browser.ts";
import { parseLocalFileCommand } from "./localFileCommands.ts";
import { executeBrowserCommand, parseBrowserCommand, validateBrowserCommandResult } from "./userCommands.ts";
import { createBrowserAuthority } from "./authority.ts";
import { decodeBrowserCommit } from "./client.ts";

const file = { path: "/Users/test/notes.txt", name: "Notes", kind: "file" };
const run = (store, command) => executeBrowserCommand(store, parseBrowserCommand(command));

test("local file commands validate paths and reject native authority and extra fields", () => {
  const command = { method: "pinLocalFiles", windowId: "w", files: [file] };
  assert.deepEqual(parseLocalFileCommand(command), command);
  assert.equal(parseLocalFileCommand({ ...command, files: [{ ...file, path: "//Users/test//notes.txt" }] }).files[0].path, file.path);
  for (const path of ["relative.txt", "file:///tmp/a", "/tmp/../secret", "/tmp/./a", "/tmp/a\0b"])
    assert.throws(() => parseLocalFileCommand({ ...command, files: [{ ...file, path }] }), { code: "invalid_request" });
  for (const key of ["grant", "bookmark", "nativeHandle", "id", "spaceId", "createdAt"])
    assert.throws(() => parseBrowserCommand({ ...command, files: [{ ...file, [key]: "forged" }] }), { code: "invalid_request" });
  assert.throws(() => parseBrowserCommand({ ...command, trusted: true }), { code: "invalid_request" });
  assert.throws(() => parseBrowserCommand({ ...command, files: Array(10_001).fill(file) }), { code: "invalid_request" });
  assert.throws(() => parseBrowserCommand({ method: "moveLocalFile", id: "f" }), { code: "invalid_request" });
  assert.throws(() => parseBrowserCommand({ method: "setLocalFileExpanded", id: "f", expanded: 1 }), { code: "invalid_request" });
});

test("local file commands run metadata reducers and reject invalid contexts before mutation", () => {
  const store = createBrowserStore();
  const s = () => store.getState();
  const windowId = s().createWindow();
  const [id] = run(store, { method: "pinLocalFiles", windowId, files: [file] });
  const [folder] = run(store, { method: "pinLocalFiles", windowId, files: [{ path: "/tmp", name: "Temp", kind: "folder" }] });
  assert.deepEqual(run(store, { method: "pinLocalFiles", windowId, files: [file] }), [id]);
  run(store, { method: "renameLocalFile", id, name: "Renamed" });
  run(store, { method: "setLocalFileExpanded", id: folder, expanded: true });
  run(store, { method: "moveLocalFile", id: folder, beforeId: id });
  assert.equal(s().localFiles[id].name, "Renamed");
  assert.equal(s().localFiles[folder].expanded, true);
  assert.ok(s().localFiles[folder].order < s().localFiles[id].order);
  const otherSpace = s().createSpace({ name: "Other" });
  const [other] = run(store, { method: "pinLocalFiles", windowId, spaceId: otherSpace, files: [file] });
  const privateId = s().createWindow({ incognito: true });
  const smallId = s().createWindow({ small: true, url: "https://example.com" });
  for (const command of [
    { method: "pinLocalFiles", windowId: privateId, files: [file] },
    { method: "pinLocalFiles", windowId: smallId, files: [file] },
    { method: "pinLocalFiles", windowId, spaceId: "missing", files: [file] },
    { method: "moveLocalFile", id, beforeId: other },
    { method: "removeLocalFile", id: "missing" },
  ]) {
    const before = s();
    assert.throws(() => run(store, command), { code: "invalid_request" });
    assert.strictEqual(s(), before);
  }
  run(store, { method: "removeLocalFile", id });
  assert.equal(s().localFiles[id], undefined);
});

test("pin replies accept only a bounded ID list, including duplicate pins and no files", () => {
  const c = parseBrowserCommand({ method: "pinLocalFiles", windowId: "w", files: [] });
  for (const value of [[], ["id"], ["id", "id"]]) assert.ok(validateBrowserCommandResult(c, value));
  for (const value of [null, "id", [""], [" "], [42], ["x".repeat(1025)], Array(10_001).fill("id")])
    assert.equal(validateBrowserCommandResult(c, value), false);
});

test("authority attributes sidebar edits to authenticated command origin and routes undo", async () => {
  const store = createBrowserStore();
  const windowId = store.getState().createWindow();
  const focused = store.getState().createWindow();
  store.getState().setFocusedWindow(focused);
  const authority = createBrowserAuthority({ epoch: "files", store });
  const send = (requestId, command) => authority.dispatch({ epoch: "files", clientId: "client", originWindowId: windowId, requestId, command });
  const added = await send(1, { method: "pinLocalFiles", windowId, files: [file] });
  assert.equal(added.value.length, 1);
  const id = added.value[0];
  const commit = decodeBrowserCommit(added.commit);
  assert.equal(commit.state.localFiles[id].path, file.path);
  assert.equal(commit.state.sidebarUndo[windowId].length, 1);
  assert.equal(commit.state.sidebarUndo[focused], undefined);
  for (const originWindowId of [store.getState().createWindow({ incognito: true }), store.getState().createWindow({ small: true })]) {
    const before = store.getState();
    await assert.rejects(
      authority.dispatch({
        epoch: "files",
        clientId: originWindowId,
        originWindowId,
        requestId: 1,
        command: { method: "renameLocalFile", id, name: "Forbidden" },
      }),
      { code: "invalid_request" },
    );
    assert.strictEqual(store.getState(), before);
  }
  await send(2, { method: "renameLocalFile", id, name: "Renamed" });
  await send(3, { method: "undoSidebarEdit", windowId });
  assert.equal(store.getState().localFiles[id].name, file.name);
  await send(4, { method: "undoSidebarEdit", windowId });
  assert.equal(store.getState().localFiles[id], undefined);
  authority.close();
});
