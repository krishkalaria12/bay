import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore } from "../store/browser.ts";
import { activeTabId } from "../store/model.ts";
import { executeTabCommand, parseTabCommand } from "./tabCommands.ts";
import { executeBrowserCommand, parseBrowserCommand } from "./userCommands.ts";
import { executeWindowUiCommand, parseWindowUiCommand, renamesInPlace, WINDOW_UI_COMMAND_METHODS } from "./windowUiCommands.ts";
import { withSidebarUndoWindow } from "../store/sidebarUndo.ts";

const run = (store, command) => executeWindowUiCommand(store, parseWindowUiCommand(command));
const download = (id, profile) => ({ id, url: `https://${id}.example/`, filename: id, path: "", state: "complete", received: 1, total: 1, profile });
function setup() {
  const store = createBrowserStore();
  const s = () => store.getState();
  const windowId = s().createWindow({ url: "a.com" });
  const privateWindow = s().createWindow({ incognito: true, url: "p.com" });
  const privateSpace = s().windows[privateWindow].spaceId;
  for (const d of [download("public", "default"), download("secret", privateSpace)]) s().upsertDownload(d);
  return { store, s, windowId, privateWindow, tab: activeTabId(s(), windowId) };
}

test("window UI parser closes every command and the find patch", () => {
  const commands = [
    { method: "setDownloadsOpen", windowId: "w", open: true },
    { method: "setFind", tabId: "t", patch: { open: true, query: "q", count: null, active: 0, focusRequest: 1_700_000_000_000, replace: false } },
    { method: "removeDownload", windowId: "w", downloadId: "d" },
    { method: "clearDownloads", windowId: "w" },
    { method: "updateDownloadFile", id: "d", patch: { filename: "b.pdf", path: "/tmp/b.pdf" } },
  ];
  assert.deepEqual(new Set(commands.map((c) => c.method)), new Set(WINDOW_UI_COMMAND_METHODS));
  for (const command of commands) {
    const parsed = parseWindowUiCommand(command);
    assert.deepEqual(parsed, command);
    assert.notEqual(parsed, command);
    assert.throws(() => parseWindowUiCommand({ ...command, native: true }), { code: "invalid_request" });
  }
  for (const command of [
    { method: "upsertDownload", download: {} },
    { method: "setFind", tabId: "t", patch: { sessionId: "x" } },
    { method: "setFind", tabId: "t", patch: { active: -1 } },
    { method: "clearDownloads" },
  ])
    assert.throws(() => parseWindowUiCommand(command), { code: "invalid_request" }, JSON.stringify(command));

  const details = { method: "updateTabDetails", tabId: "t", patch: { customTitle: null, customIcon: "★", kept: true } };
  assert.deepEqual(parseTabCommand(details), details);
  for (const field of ["url", "title", "zoom", "pinnedUrl"])
    assert.throws(() => parseTabCommand({ ...details, patch: { [field]: "x" } }), { code: "invalid_request" }, field);
  // The panel wrapper omits text it wasn't given.
  assert.deepEqual(parseBrowserCommand({ method: "openCommandPanel", windowId: "w", initialText: undefined }), { method: "openCommandPanel", windowId: "w" });
});

test("window UI commands toggle panels, find and a window's own downloads", () => {
  const { store, s, windowId, privateWindow, tab } = setup();
  run(store, { method: "setDownloadsOpen", windowId, open: true });
  assert.equal(s().windowUi[windowId].downloadsOpen, true);
  run(store, { method: "setFind", tabId: tab, patch: { open: true, query: "needle" } });
  assert.deepEqual([s().find[tab].open, s().find[tab].query], [true, "needle"]);
  executeTabCommand(store, parseTabCommand({ method: "updateTabDetails", tabId: tab, patch: { customTitle: "Mine", kept: true } }));
  assert.deepEqual([s().tabs[tab].customTitle, s().tabs[tab].kept], ["Mine", true]);
  executeBrowserCommand(store, parseBrowserCommand({ method: "openCommandPanel", windowId, initialText: "x" }));
  assert.equal(s().windowUi[windowId].panel.open, true);

  for (const command of [
    { method: "removeDownload", windowId, downloadId: "secret" },
    { method: "removeDownload", windowId: privateWindow, downloadId: "public" },
    { method: "removeDownload", windowId, downloadId: "missing" },
    { method: "setFind", tabId: "missing", patch: { open: true } },
    { method: "setDownloadsOpen", windowId: "missing", open: true },
  ]) {
    const before = s();
    assert.throws(() => run(store, command), { code: "invalid_request" }, JSON.stringify(command));
    assert.equal(s(), before);
  }
  run(store, { method: "removeDownload", windowId, downloadId: "public" });
  assert.deepEqual(
    s().downloads.map((d) => d.id),
    ["secret"],
  );
  s().upsertDownload(download("again", "default"));
  run(store, { method: "clearDownloads", windowId });
  assert.deepEqual(
    s().downloads.map((d) => d.id),
    ["secret"],
    "a regular window's Clear leaves the private window's list alone",
  );
});

test("download renames stay in the file's folder and in the origin window's list", () => {
  const { store, s, windowId, privateWindow } = setup();
  const finished = (id, profile, path) => ({ ...download(id, profile), state: "finished", filename: path.split(/[\\/]/).pop(), path });
  s().upsertDownload(finished("done", "default", "/Users/me/Downloads/file.pdf"));
  s().upsertDownload(finished("win", "default", "C:\\Users\\me\\Downloads\\file.pdf"));
  s().upsertDownload({ ...download("busy", "default"), state: "downloading", path: "/Users/me/Downloads/busy.pdf" });

  assert.equal(renamesInPlace("/a/b.pdf", { filename: "c.pdf", path: "/a/c.pdf" }), true);
  for (const to of [
    { filename: "c.pdf", path: "/elsewhere/c.pdf" },
    { filename: "c.pdf", path: "/a/d.pdf" },
    { filename: "..", path: "/a/.." },
    { filename: "x/c.pdf", path: "/a/x/c.pdf" },
  ])
    assert.equal(renamesInPlace("/a/b.pdf", to), false, JSON.stringify(to));

  for (const command of [
    { method: "updateDownloadFile", id: "done", patch: { filename: "x.pdf", path: "/Users/me/Desktop/x.pdf" } },
    { method: "updateDownloadFile", id: "busy", patch: { filename: "x.pdf", path: "/Users/me/Downloads/x.pdf" } },
    { method: "updateDownloadFile", id: "public", patch: { filename: "x.pdf", path: "/x.pdf" } },
    { method: "updateDownloadFile", id: "missing", patch: { filename: "x.pdf", path: "/x.pdf" } },
  ]) {
    const before = s();
    assert.throws(() => run(store, command), { code: "invalid_request" }, JSON.stringify(command));
    assert.equal(s(), before);
  }
  const rename = { method: "updateDownloadFile", id: "done", patch: { filename: "Report.pdf", path: "/Users/me/Downloads/Report.pdf" } };
  assert.throws(() => withSidebarUndoWindow(privateWindow, () => run(store, rename)), { code: "invalid_request" });
  withSidebarUndoWindow(windowId, () => run(store, rename));
  run(store, { method: "updateDownloadFile", id: "win", patch: { filename: "Report.pdf", path: "C:\\Users\\me\\Downloads\\Report.pdf" } });
  assert.deepEqual(
    ["done", "win"].map((id) => s().downloads.find((d) => d.id === id)).map((d) => [d.filename, d.path]),
    [
      ["Report.pdf", "/Users/me/Downloads/Report.pdf"],
      ["Report.pdf", "C:\\Users\\me\\Downloads\\Report.pdf"],
    ],
  );
});
