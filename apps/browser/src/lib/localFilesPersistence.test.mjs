import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../test-native-stub.mjs");
const { useBrowser } = await import("../store/browser.ts");
const { startPersistence, flushPersistence, loadSession } = await import("./persist.ts");
const S = () => useBrowser.getState();

test("file pins survive relaunch as metadata without bookmark grants or device status", () => {
  stub.docs.clear();
  const stop = startPersistence();
  try {
    const value = {
      id: "pdf",
      spaceId: "default",
      path: "/Users/owner/Documents/Report.pdf",
      name: "Report.pdf",
      kind: "file",
      createdAt: 100,
      order: 2,
      expanded: false,
    };
    useBrowser.setState({ localFiles: { pdf: { ...value, bookmark: "native-secret", status: "available" } } });
    flushPersistence();
    const saved = JSON.parse(stub.docs.get("session.json"));
    assert.deepEqual(saved.localFiles, [value]);
    S().hydrate(loadSession());
    assert.deepEqual(S().localFiles.pdf, value);
    assert.equal(S().localFileAccess?.pdf, undefined);
    saved.localFiles = [null, { id: "broken" }, value];
    stub.docs.set("session.json", JSON.stringify(saved));
    S().hydrate(loadSession());
    assert.deepEqual(S().localFiles, { pdf: value });
    delete saved.localFiles;
    stub.docs.set("session.json", JSON.stringify(saved));
    S().hydrate(loadSession());
    assert.deepEqual(S().localFiles, {});
  } finally {
    flushPersistence();
    stop();
  }
});

test("session file pins reject private, unknown-space and malformed paths", () => {
  stub.docs.clear();
  const stop = startPersistence();
  try {
    const pin = {
      id: "valid",
      spaceId: "default",
      path: "/Users/owner/Documents/Report.pdf",
      name: "Report.pdf",
      kind: "file",
      createdAt: 100,
      order: 0,
      expanded: false,
    };
    useBrowser.setState({
      localFiles: {
        valid: pin,
        private: { ...pin, id: "private", spaceId: "incognito:window" },
        unknown: { ...pin, id: "unknown", spaceId: "gone" },
        relative: { ...pin, id: "relative", path: "../secret" },
      },
    });
    flushPersistence();
    const saved = JSON.parse(stub.docs.get("session.json"));
    assert.deepEqual(saved.localFiles, [pin]);
  } finally {
    flushPersistence();
    stop();
  }
});
