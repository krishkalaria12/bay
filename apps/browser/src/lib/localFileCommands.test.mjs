import assert from "node:assert/strict";
import { test } from "node:test";
import { installServiceClient } from "../runtime/serviceClient.ts";
import { useBrowser } from "../store/browserStore.ts";
import { closeLocalFileTab, openLocalFile, peekLocalFile, reconnectLocalFile } from "./localFiles.ts";

test("window file actions use the coordinator client without writing a local store", async () => {
  const before = useBrowser.getState();
  const calls = [];
  const access = { status: "available", browserReadable: true, url: "file:///approved/report.pdf" };

  const remove = installServiceClient(async (action, args) => {
    calls.push({ action, args });

    return action === "localFileReconnect" ? true : action === "localFileClose" ? null : access;
  });

  try {
    assert.deepEqual(await openLocalFile("window", "pin", "report.pdf"), access);
    assert.deepEqual(await peekLocalFile("window", "pin", "report.pdf"), access);
    assert.equal(await reconnectLocalFile("pin"), true);
    await closeLocalFileTab("window", "pin", "report.pdf");
    assert.deepEqual(calls, [
      { action: "localFileOpen", args: ["window", "pin", "report.pdf"] },
      { action: "localFilePeek", args: ["window", "pin", "report.pdf"] },
      { action: "localFileReconnect", args: ["pin"] },
      { action: "localFileClose", args: ["window", "pin", "report.pdf"] },
    ]);
    assert.equal(useBrowser.getState(), before);
  } finally {
    remove();
  }
});

test("a rejected file command stays rejected without a local fallback", async () => {
  const before = useBrowser.getState();
  const error = new Error("coordinator disconnected");

  const remove = installServiceClient(async () => {
    throw error;
  });

  try {
    await assert.rejects(openLocalFile("window", "pin"), error);
    await assert.rejects(peekLocalFile("window", "pin"), error);
    await assert.rejects(reconnectLocalFile("pin"), error);
    assert.equal(useBrowser.getState(), before);
  } finally {
    remove();
  }
});
