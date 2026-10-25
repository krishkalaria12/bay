import assert from "node:assert/strict";
import { test } from "node:test";
import { localFileAnswers } from "../test-native-stub.mjs";
import { useBrowser } from "../store/browser.ts";
import { closeLocalFileTab, openLocalFile, peekLocalFile, reconnectLocalFile, localFileStatusText } from "./localFiles.ts";

const S = () => useBrowser.getState();
const setup = () => {
  S().hydrate({});
  const windowId = S().createWindow({});
  const [id] = S().pinLocalFiles(windowId, [{ path: "/Users/owner/A #1.pdf", name: "Report", kind: "file" }]);
  return { windowId, id };
};

test("PDF/image/HTML native browser opens create one file tab and reuse it", async () => {
  const { windowId, id } = setup();
  for (const filename of ["A%20%231.pdf", "photo.png", "index.html"]) {
    localFileAnswers.open = async (root, relative) => {
      assert.equal(root, "/Users/owner/A #1.pdf");
      assert.equal(relative, "");
      return { status: "available", url: `file:///Users/owner/${filename}`, name: "Original", browserReadable: true };
    };
    const count = Object.keys(S().tabs).length;
    await openLocalFile(windowId, id);
    await openLocalFile(windowId, id);
    assert.equal(Object.keys(S().tabs).length, count + 1);
    const tab = Object.values(S().tabs).find((t) => t.url.endsWith(filename));
    assert.equal(tab.title, "Report");
  }
});

test("missing grants, external formats and invalid native URLs do not create browser tabs", async () => {
  const { windowId, id } = setup();
  const count = Object.keys(S().tabs).length;
  for (const access of [
    { status: "missing" },
    { status: "inaccessible" },
    { status: "available", browserReadable: false },
    { status: "available", browserReadable: true, url: "https://evil.test" },
  ]) {
    localFileAnswers.open = async () => access;
    await openLocalFile(windowId, id);
    assert.equal(Object.keys(S().tabs).length, count);
  }
  assert.equal(localFileStatusText({ status: "missing" }), "Missing on this Mac");
  assert.equal(localFileStatusText({ status: "inaccessible" }), "Access required on this Mac");
});

test("nested file opens forward only a root grant plus relative path", async () => {
  const { windowId, id } = setup();
  localFileAnswers.open = async (root, relative) => {
    assert.equal(root, "/Users/owner/A #1.pdf");
    assert.equal(relative, "Work/Photo.png");
    return { status: "available", browserReadable: true, url: "file:///Users/owner/Work/Photo.png", name: "Photo.png" };
  };
  await openLocalFile(windowId, id, "Work/Photo.png");
  assert.equal(Object.values(S().tabs).find((t) => t.url.endsWith("Photo.png")).title, "Photo.png");
});

test("late native resolution does not open a file after its pin was removed", async () => {
  const { windowId, id } = setup();
  let finish;
  localFileAnswers.open = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const count = Object.keys(S().tabs).length;
  const pending = openLocalFile(windowId, id);
  S().removeLocalFile(id);
  finish({ status: "available", browserReadable: true, url: "file:///Users/owner/A.pdf" });
  assert.equal((await pending).status, "inaccessible");
  assert.equal(Object.keys(S().tabs).length, count);
});

test("reconnecting changes only the native local grant and cancelled pickers preserve the pin", async () => {
  const { id } = setup();
  const before = S().localFiles;
  localFileAnswers.reconnect = async (root, kind) => {
    assert.equal(root, "/Users/owner/A #1.pdf");
    assert.equal(kind, "file");
    return { path: "/Users/other/A.pdf", kind: "file", name: "A.pdf" };
  };
  assert.equal(await reconnectLocalFile(id), true);
  assert.equal(S().localFiles, before);
  localFileAnswers.reconnect = async () => null;
  assert.equal(await reconnectLocalFile(id), false);
  assert.equal(S().localFiles, before);
});

test("Space previews a file over the active page and descendant close affects only its file tab", async () => {
  const { windowId, id } = setup();
  const from = S().windows[windowId].activeTabIds.default;
  const access = { status: "available", browserReadable: true, url: "file:///Users/owner/Work/Photo.png", name: "Photo.png" };
  localFileAnswers.inspect = async () => access;
  localFileAnswers.open = async () => access;
  await peekLocalFile(windowId, id, "Work/Photo.png");
  const peek = Object.values(S().tabs).find((tab) => tab.peekOf === from);
  assert.equal(peek.url, access.url);
  await openLocalFile(windowId, id, "Work/Photo.png");
  const opened = Object.values(S().tabs).find((tab) => tab.url === access.url && !tab.peekOf);
  assert.ok(opened);
  await closeLocalFileTab(windowId, id, "Work/Photo.png");
  assert.equal(S().tabs[opened.id], undefined);
  assert.ok(S().tabs[from]);
  assert.ok(S().localFiles[id], "closing a descendant does not unpin its root or delete files");
});

test("preview cannot open a file on a Mac without a local native grant", async () => {
  const { windowId, id } = setup();
  localFileAnswers.inspect = async () => ({ status: "inaccessible" });
  const tabs = S().tabs;
  assert.equal((await peekLocalFile(windowId, id)).status, "inaccessible");
  assert.equal(S().tabs, tabs);
});

test("a file preview stays in the requested window when its shared active tab is hosted elsewhere", async () => {
  const { windowId, id } = setup();
  const from = S().windows[windowId].activeTabIds.default;
  const second = S().createWindow({});
  S().activate(from, second);
  assert.equal(S().tabs[from].windowId, second);
  assert.equal(S().windows[windowId].activeTabIds.default, from);
  localFileAnswers.inspect = async () => ({ status: "available", browserReadable: true, url: "file:///Users/owner/A.pdf" });
  await peekLocalFile(windowId, id);
  assert.ok(S().peeks[windowId]);
  assert.equal(S().peeks[second], undefined);
  assert.equal(S().tabs[S().peeks[windowId].tabId].windowId, windowId);
});
