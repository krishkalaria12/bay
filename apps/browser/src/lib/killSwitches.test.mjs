import assert from "node:assert/strict";
import { test } from "node:test";
import { refreshKillSwitches, switchedOff, SWITCHES_URL, useKillSwitches } from "./killSwitches.ts";

const WEBKIT = { id: "a", feature: "webkit", reason: "WebKit pages crash." };

// A fake feed: "signed" when the signature is "good", issued as the feed says.
function deps({ published, kept = null, online = true } = {}) {
  const written = [];
  const checks = [];

  return {
    written,
    checks,
    fetch: async (url) => {
      if (!online) throw new Error("offline");
      const body = url === SWITCHES_URL ? published?.feed : published?.signature;

      return { ok: body !== undefined, text: async () => body };
    },
    check: async (feed, signature, lastIssued) => {
      checks.push({ feed, lastIssued });

      if (signature !== "good") return { ok: false, error: "signature" };
      const parsed = JSON.parse(feed);

      if (parsed.issued < lastIssued) return { ok: false, error: "stale" };

      return { ok: true, issued: parsed.issued, switches: parsed.switches };
    },
    read: () => (kept ? JSON.stringify(kept) : null),
    write: (text) => written.push(JSON.parse(text)),
    now: () => 42,
  };
}

const feed = (issued, switches) => JSON.stringify({ issued, switches });

test("a published feed that checks out is applied and kept", async () => {
  useKillSwitches.setState({ active: [], checkedAt: null });
  const d = deps({ published: { feed: feed(10, [WEBKIT]), signature: "good" } });

  assert.equal(await refreshKillSwitches(d), "updated");
  assert.equal(switchedOff("webkit"), true);
  assert.equal(switchedOff("askPage"), false);
  assert.deepEqual(d.written, [{ feed: feed(10, [WEBKIT]), signature: "good", issued: 10 }]);
});

test("the kept feed applies offline", async () => {
  useKillSwitches.setState({ active: [], checkedAt: null });
  const d = deps({ kept: { feed: feed(10, [WEBKIT]), signature: "good", issued: 10 }, online: false });

  assert.equal(await refreshKillSwitches(d), "kept");
  assert.equal(switchedOff("webkit"), true);
});

test("a refused or older feed leaves the kept one standing", async () => {
  const kept = { feed: feed(10, [WEBKIT]), signature: "good", issued: 10 };

  for (const published of [
    { feed: feed(11, []), signature: "forged" },
    { feed: feed(9, []), signature: "good" },
  ]) {
    useKillSwitches.setState({ active: [], checkedAt: null });
    const d = deps({ kept, published });

    assert.equal(await refreshKillSwitches(d), "kept");
    assert.equal(switchedOff("webkit"), true);
    assert.deepEqual(d.written, []);
    assert.equal(d.checks.at(-1).lastIssued, 10);
  }
});

test("a newer feed lifts a switch", async () => {
  useKillSwitches.setState({ active: [WEBKIT], checkedAt: null });
  const d = deps({ kept: { feed: feed(10, [WEBKIT]), signature: "good", issued: 10 }, published: { feed: feed(12, []), signature: "good" } });

  assert.equal(await refreshKillSwitches(d), "updated");
  assert.equal(switchedOff("webkit"), false);
});

test("without the native check nothing changes", async () => {
  useKillSwitches.setState({ active: [], checkedAt: null });
  const d = { ...deps({ published: { feed: feed(10, [WEBKIT]), signature: "good" } }), check: async () => null };

  assert.equal(await refreshKillSwitches(d), "unavailable");
  assert.equal(switchedOff("webkit"), false);
});
