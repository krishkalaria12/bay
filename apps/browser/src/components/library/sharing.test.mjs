import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { docs, easelSharingAnswers, heldSaves, keychainAnswers } from "../../test-native-stub.mjs";
import { easelShareURL, publishEasel, startEaselShares, stopSharingEasel, useEaselShares } from "./sharing.ts";

const originalFetch = globalThis.fetch;
const secrets = new Map();
const requests = [];
let count;
beforeEach(() => {
  docs.clear();
  secrets.clear();
  requests.length = 0;
  count = 0;
  heldSaves.error = null;
  easelSharingAnswers.enabled = true;
  useEaselShares.setState({ loaded: false, error: null, records: {}, busy: {} });
  keychainAnswers.get = async (account) => secrets.get(account) ?? null;
  keychainAnswers.set = async (account, key) => (secrets.set(account, key), true);
  keychainAnswers.delete = async (account) => (secrets.delete(account), true);
  easelSharingAnswers.identity = async () => ({ id: (++count).toString(16).padStart(32, "0"), key: "b".repeat(64) });
  easelSharingAnswers.readRecords = () => docs.get("easel-shares.json") ?? null;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    return new Response(null, { status: options.method === "DELETE" ? 204 : 200 });
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  heldSaves.error = null;
  easelSharingAnswers.enabled = false;
});
const snapshot = async () => JSON.stringify({ version: 1, title: "References", background: "#FFFFFF", image: null, links: [] });

test("disabled sharing cannot prepare, publish, create credentials or send requests", async () => {
  easelSharingAnswers.enabled = false;
  await assert.rejects(
    publishEasel("board", () => assert.fail("must not render while disabled")),
    /disabled/,
  );
  await stopSharingEasel("unshared");
  assert.equal(requests.length, 0);
  assert.equal(secrets.size, 0);
  assert.equal(docs.has("easel-shares.json"), false);
});

test("disabling sharing preserves existing publication ownership without network access", async () => {
  await publishEasel("board", snapshot);
  const saved = docs.get("easel-shares.json");
  easelSharingAnswers.enabled = false;
  await assert.rejects(stopSharingEasel("board"), /disabled/);
  await assert.rejects(publishEasel("board", snapshot), /disabled/);
  assert.equal(docs.get("easel-shares.json"), saved);
  assert.equal(requests.length, 1);
  assert.equal(secrets.size, 1);
});

test("publish persists ownership before upload and keeps its management key out of documents and public links", async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const saved = JSON.parse(docs.get("easel-shares.json"));
    assert.equal(saved.records.board.publishedAt, null);
    assert.equal(secrets.size, 1);
    return fetch(...args);
  };
  const url = await publishEasel("board", snapshot);
  assert.equal(url, easelShareURL("1".padStart(32, "0")));
  assert.ok(!url.includes("b".repeat(64)));
  assert.ok(!docs.get("easel-shares.json").includes("b".repeat(64)));
  assert.equal(requests[0].headers.Authorization, `Bearer ${"b".repeat(64)}`);
  assert.equal(requests[0].redirect, "error");
  assert.deepEqual(JSON.parse(requests[0].body), { ...JSON.parse(await snapshot()), revision: 1 });
  assert.ok(useEaselShares.getState().records.board.publishedAt > 0);
});

test("updates and retries reuse the same URL and remain explicit", async () => {
  const first = await publishEasel("board", snapshot);
  await publishEasel("board", async () => JSON.stringify({ ...JSON.parse(await snapshot()), title: "Updated snapshot" }));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, requests[1].url);
  assert.equal(JSON.parse(requests[1].body).title, "Updated snapshot");
  assert.equal(JSON.parse(requests[1].body).revision, 2);
  assert.equal(count, 1);
  useEaselShares.setState({ loaded: false, records: {} });
  startEaselShares();
  assert.equal(await publishEasel("board", snapshot), first);
  assert.equal(JSON.parse(requests[2].body).revision, 3);
});

test("interrupted first upload retains its key and record for retry or revocation", async () => {
  globalThis.fetch = async () => {
    throw new Error("connection lost");
  };
  await assert.rejects(publishEasel("board", snapshot), /connection lost/);
  const pending = useEaselShares.getState().records.board;
  assert.equal(pending.publishedAt, null);
  assert.equal(secrets.size, 1);
  globalThis.fetch = async (url, options) => {
    assert.ok(url.endsWith(pending.id));
    assert.equal(options.method, "DELETE");
    return new Response(null, { status: 204 });
  };
  await stopSharingEasel("board");
  assert.equal(useEaselShares.getState().records.board, undefined);
  assert.equal(secrets.size, 0);
});

test("failed revocation keeps ownership, successful revocation permits a fresh independent link", async () => {
  const first = await publishEasel("board", snapshot);
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(stopSharingEasel("board"), /503/);
  assert.ok(useEaselShares.getState().records.board);
  assert.equal(secrets.size, 1);
  globalThis.fetch = fetch;
  await stopSharingEasel("board");
  assert.equal(useEaselShares.getState().records.board, undefined);
  assert.equal(secrets.size, 0);
  assert.notEqual(await publishEasel("board", snapshot), first);
});

test("failed durable save or Keychain save never sends an upload", async () => {
  heldSaves.error = new Error("disk full");
  await assert.rejects(publishEasel("board", snapshot), /disk full/);
  assert.equal(requests.length, 0);
  assert.equal(useEaselShares.getState().records.board, undefined);
  heldSaves.error = null;
  keychainAnswers.set = async () => false;
  await assert.rejects(publishEasel("board", snapshot), /Keychain/);
  assert.equal(requests.length, 0);
});

test("snapshot failure never creates a publication and missing Keychain credentials never send mutations", async () => {
  await assert.rejects(
    publishEasel("board", async () => {
      throw new Error("missing image");
    }),
    /missing image/,
  );
  assert.equal(secrets.size, 0);
  await publishEasel("board", snapshot);
  secrets.clear();
  await assert.rejects(publishEasel("board", snapshot), /Keychain/);
  await assert.rejects(stopSharingEasel("board"), /Keychain/);
  assert.equal(requests.length, 1);
});

test("corrupt sharing records stay untouched and refuse publication or revocation", async () => {
  docs.set("easel-shares.json", "unreadable");
  await assert.rejects(publishEasel("board", snapshot), /read Easel sharing records/);
  await assert.rejects(stopSharingEasel("board"), /read Easel sharing records/);
  assert.equal(docs.get("easel-shares.json"), "unreadable");
  assert.equal(requests.length, 0);
});

test("registry read failures cannot masquerade as a missing file or discard publication ownership", async () => {
  await publishEasel("board", snapshot);
  const saved = docs.get("easel-shares.json");
  useEaselShares.setState({ loaded: false, records: {} });
  easelSharingAnswers.readRecords = () => {
    throw new Error("Invalid UTF-8 or permission denied");
  };
  await assert.rejects(stopSharingEasel("board"), /read Easel sharing records/);
  await assert.rejects(publishEasel("other", snapshot), /read Easel sharing records/);
  assert.equal(docs.get("easel-shares.json"), saved);
  assert.equal(secrets.size, 1);
  assert.equal(requests.length, 1);
});

test("failed requests reserve revisions durably before the next update", async () => {
  await publishEasel("board", snapshot);
  const fetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    await fetch(...args);
    throw new Error("response lost");
  };
  await assert.rejects(publishEasel("board", snapshot), /response lost/);
  assert.equal(JSON.parse(docs.get("easel-shares.json")).records.board.revision, 2);
  globalThis.fetch = fetch;
  await publishEasel("board", snapshot);
  assert.deepEqual(
    requests.map((r) => JSON.parse(r.body).revision),
    [1, 2, 3],
  );
});

test("same-Easel mutations cannot race and simultaneous different Easels retain both durable records", async () => {
  let release;
  const pending = publishEasel(
    "board",
    () =>
      new Promise((resolve) => {
        release = () => resolve("{}");
      }),
  );
  await assert.rejects(publishEasel("board", snapshot), /already being shared/);
  await assert.rejects(stopSharingEasel("board"), /already being shared/);
  const other = publishEasel("other", snapshot);
  release();
  await Promise.all([pending, other]);
  assert.deepEqual(Object.keys(JSON.parse(docs.get("easel-shares.json")).records).sort(), ["board", "other"]);
  assert.deepEqual(useEaselShares.getState().busy, {});
});

test("failed post-upload save retains the pending record and management key", async () => {
  globalThis.fetch = async () => {
    heldSaves.error = new Error("disk full after upload");
    return new Response(null, { status: 200 });
  };
  await assert.rejects(publishEasel("board", snapshot), /disk full after upload/);
  assert.equal(useEaselShares.getState().records.board.publishedAt, null);
  assert.equal(secrets.size, 1);
  assert.equal(JSON.parse(docs.get("easel-shares.json")).records.board.publishedAt, null);
});
