import assert from "node:assert/strict";
import { test } from "node:test";
import { parseServiceCommand, parseServiceResult } from "./serviceCommands.ts";
import { installServiceClient } from "./serviceClient.ts";
import { live, setLive, updateFolder, setLiveView, markUnread } from "../activity/activityStore.ts";

const command = (action, args = []) => parseServiceCommand({ method: "serviceAction", action, args });

test("service commands reject arbitrary data and internal identity patches", () => {
  for (const value of [
    { method: "serviceAction", action: "setLive", args: [{}] },
    { method: "serviceAction", action: "liveUpdate", args: ["f", { spaceId: "private" }] },
    { method: "serviceAction", action: "liveConfig", args: [{ client_secret: "secret" }] },
    { method: "serviceAction", action: "liveConnect", args: ["github", ["token", "extra"]] },
    { method: "serviceAction", action: "liveConnect", args: ["gdrive", ["token"]] },
    { method: "serviceAction", action: "calendarSettings", args: [{ alertLead: "15" }] },
    { method: "serviceAction", action: "liveMove", args: ["f", 2] },
    { method: "serviceAction", action: "syncNow", args: [], extra: true },
  ])
    assert.throws(() => parseServiceCommand(value), { code: "invalid_request" });
  assert.deepEqual(command("calendarSettings", [{ alertLead: "start", showPreview: false }]).args, [{ alertLead: "start", showPreview: false }]);
});

test("service results allow requester data and reject credentials", () => {
  assert.deepEqual(parseServiceResult({ ok: true }, "turnOnSync"), { ok: true });
  assert.deepEqual(parseServiceResult({ error: "wordCount", count: 3 }, "enterRecoveryPhrase"), { error: "wordCount", count: 3 });
  assert.equal(parseServiceResult(null, "liveCreate"), null);
  assert.throws(() => parseServiceResult({ ok: true, token: "secret" }, "turnOnSync"));
  assert.throws(() => parseServiceResult("ignored", "syncNow"));
  assert.throws(() => parseServiceResult({ id: "f", userCode: "code", verificationUri: "https://example.com", expiresAt: Infinity }, "githubStart"));
});

test("window service APIs dispatch without changing auxiliary stores", async () => {
  setLive({ folders: { f: { id: "f", name: "Original" } }, expandedStacks: {}, unread: {} });
  const before = live();
  const calls = [];

  const stop = installServiceClient(async (action, args) => {
    calls.push({ action, args });

    return null;
  });

  try {
    updateFolder("f", { name: "New" });
    setLiveView("expandedStacks", "stack", true);
    markUnread("f", "item");
    assert.equal(live(), before);
    assert.deepEqual(
      calls.map((c) => c.action),
      ["liveUpdate", "liveView", "liveUnread"],
    );
  } finally {
    stop();
  }
});

test("file and download service commands accept granted metadata and reject path escapes", () => {
  assert.deepEqual(command("localFileOpen", ["w", "pin", "nested/report.pdf"]).args, ["w", "pin", "nested/report.pdf"]);
  assert.deepEqual(command("localFilePeek", ["w", "pin", ""]).args, ["w", "pin", ""]);

  for (const path of ["../secret", "/secret", "C:\\secret", "nested/../secret", "nested\\..\\secret", "bad\0path"])
    assert.throws(() => command("localFileOpen", ["w", "pin", path]));

  for (const name of ["..", ".", "folder/file", "folder\\file", "bad\0name"]) assert.throws(() => command("downloadRename", ["download", name]));
  assert.equal(parseServiceResult("/Downloads/report.pdf", "downloadRename"), "/Downloads/report.pdf");
  assert.deepEqual(parseServiceResult({ status: "inaccessible" }, "localFileOpen"), { status: "inaccessible" });
  assert.throws(() => parseServiceResult({ status: "available", grant: "native-handle" }, "localFileOpen"));
  assert.throws(() => parseServiceResult({ kind: "tidied", moved: 1, groups: 1, loose: [], source: "site", secret: "hidden" }, "tidyTabs"));
});

test("settings service messages carry metadata and reject credentials or unknown mutation fields", () => {
  assert.deepEqual(command("settingsClearData", ["work", { history: true, siteData: false, since: 1 }]).args, [
    "work",
    { history: true, siteData: false, since: 1 },
  ]);
  assert.throws(() => command("settingsClearData", ["work", { history: true, siteData: false, password: "secret" }]));
  assert.throws(() => command("settingsClearData", ["work", { history: true, siteData: false, since: Infinity }]));
  const metadata = { passwords: [{ origin: "https://example.com", username: "reader", created: 1, modified: 2 }], never: [] };
  assert.deepEqual(parseServiceResult(metadata, "settingsPasswords"), metadata);
  assert.throws(() => parseServiceResult({ ...metadata, passwords: [{ ...metadata.passwords[0], password: "secret" }] }, "settingsPasswords"));
  assert.throws(() => parseServiceResult({ passwords: [], never: [], token: "secret" }, "settingsPasswords"));
  assert.deepEqual(parseServiceResult({ kind: "cancelled" }, "settingsImportCsv"), { kind: "cancelled" });
  assert.throws(() => parseServiceResult({ kind: "cancelled", saved: 0 }, "settingsImportCsv"));
  assert.deepEqual(parseServiceResult({ status: "reauthFailed" }, "settingsExportCsv"), { status: "reauthFailed" });
  assert.throws(() => parseServiceResult({ history: true, engine: "maybe" }, "settingsClearData"));
});

test("library service messages keep a bounded capture description and no native handles", () => {
  const image = { path: "/tmp/capture.png", width: 640, height: 480 };
  const source = { url: "https://example.com/", title: "Page", profileId: "" };
  assert.deepEqual(command("librarySaveMedia", ["w", image, "Capture", source]).args, ["w", image, "Capture", source]);
  assert.throws(() => command("librarySaveMedia", ["w", { ...image, grant: "handle" }, "Capture", source]));
  assert.throws(() => command("librarySaveMedia", ["w", { ...image, width: Infinity }, "Capture", source]));
  assert.throws(() => command("librarySaveMedia", ["w", { ...image, path: "relative.png" }, "Capture", source]));
  const media = { ...image, id: "m", name: "Capture", createdAt: 1, source };
  assert.deepEqual(parseServiceResult(media, "librarySaveMedia"), media);
  assert.throws(() => parseServiceResult({ ...media, nativeHandle: "handle" }, "librarySaveMedia"));
});
