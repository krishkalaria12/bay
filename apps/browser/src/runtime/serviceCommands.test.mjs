import assert from "node:assert/strict";
import { test } from "node:test";
import { parseServiceCommand, parseServiceResult } from "./serviceCommands.ts";
import { installServiceClient } from "./serviceClient.ts";
import { live, setLive, updateFolder, setLiveView, markUnread } from "../live/store.ts";
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
