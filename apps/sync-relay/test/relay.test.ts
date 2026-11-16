// The relay as a device sees it: a chain claimed by its first write, files listed, read and removed, other secrets
// turned away, and the pairing box's one envelope.
import { exports } from "cloudflare:workers";
import * as v from "valibot";
import { beforeEach, describe, expect, it } from "vitest";

/** A read's answer. */
const ReadSchema = v.object({ files: v.array(v.object({ id: v.string(), data: v.string() })), missing: v.array(v.string()) });

const BASE = "https://relay.test";
// Storage outlives a test here: each test has a chain of its own.

let chains = 0;
let CHAIN = "";

beforeEach(() => {
  chains += 1;
  CHAIN = `chain${"abcdefghijklmnopqrstuvwxyz"[chains]}`.padEnd(26, "q");
});

const SCOPE = "scopescopescopescopescope2";
const SECRET = "a".repeat(43);
const OTHER = "b".repeat(43);

/** A file's name: "file" and a letter for its number, made a tag's length. */
const id = (n: number) => `file${"abcdefghij"[n]}`.padEnd(26, "z");

const digest = async (data: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].join(",");

function call(path: string, init: RequestInit & { secret?: string } = {}) {
  const headers = new Headers(init.headers);

  if (init.secret !== undefined) headers.set("authorization", `Bearer ${init.secret}`);

  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

const put = (scope: string, file: string, body: Uint8Array, secret = SECRET) =>
  call(`/v1/chains/${CHAIN}/scopes/${scope}/files/${file}`, { method: "PUT", body, secret });

describe("health", () => {
  it("says which protocol it speaks", async () => {
    const response = await call("/v1/health");

    expect(await response.json()).toEqual({ ok: true, v: 1 });
  });
});

describe("a chain", () => {
  it("doesn't exist until its first file, which claims it", async () => {
    expect((await call(`/v1/chains/${CHAIN}`, { secret: SECRET })).status).toBe(404);
    expect((await put(SCOPE, id(1), new Uint8Array([1, 2, 3]))).status).toBe(204);

    const state = await call(`/v1/chains/${CHAIN}`, { secret: SECRET });

    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({ version: 1, size: 3 });
  });

  it("turns away another secret, and a request without one", async () => {
    await put(SCOPE, id(1), new Uint8Array([1]));

    expect((await put(SCOPE, id(2), new Uint8Array([1]), OTHER)).status).toBe(403);
    expect((await call(`/v1/chains/${CHAIN}/scopes/${SCOPE}`, { secret: OTHER })).status).toBe(403);
    expect((await call(`/v1/chains/${CHAIN}/scopes/${SCOPE}`)).status).toBe(401);
  });

  it("lists, reads and removes a scope's files, and a retried write keeps the first", async () => {
    const big = new Uint8Array(2_500_000).map((_, i) => i % 251);

    await put(SCOPE, id(1), new Uint8Array([7, 7]));
    await put(SCOPE, id(2), big);
    await put(SCOPE, id(1), new Uint8Array([9]));

    const listing = await call(`/v1/chains/${CHAIN}/scopes/${SCOPE}`, { secret: SECRET });

    expect(await listing.json()).toEqual({ ids: [id(1), id(2)], version: 2 });

    const read = await call(`/v1/chains/${CHAIN}/scopes/${SCOPE}/read`, {
      method: "POST",
      secret: SECRET,
      body: JSON.stringify({ ids: [id(2), id(1), id(3)] }),
    });

    const { files, missing } = v.parse(ReadSchema, await read.json());
    const bytes = (data: string) => Uint8Array.from(atob(data), (char) => char.charCodeAt(0));

    expect(files.map((file) => file.id)).toEqual([id(2), id(1)]);
    // Kept in parts of a megabyte, read back whole.
    expect(await digest(bytes(files[0]!.data))).toBe(await digest(big));
    expect(bytes(files[1]!.data)).toEqual(new Uint8Array([7, 7]));
    expect(missing).toEqual([id(3)]);

    await call(`/v1/chains/${CHAIN}/scopes/${SCOPE}/remove`, { method: "POST", secret: SECRET, body: JSON.stringify({ ids: [id(1)] }) });

    const after = await call(`/v1/chains/${CHAIN}/scopes/${SCOPE}`, { secret: SECRET });

    expect(await after.json()).toEqual({ ids: [id(2)], version: 3 });
  });

  it("starts again once deleted", async () => {
    await put(SCOPE, id(1), new Uint8Array([1]));
    expect((await call(`/v1/chains/${CHAIN}`, { method: "DELETE", secret: SECRET })).status).toBe(204);
    expect((await call(`/v1/chains/${CHAIN}`, { secret: OTHER })).status).toBe(404);
    expect((await put(SCOPE, id(1), new Uint8Array([1]), OTHER)).status).toBe(204);
  });

  it("refuses names that aren't tags", async () => {
    expect((await call("/v1/chains/NOT-A-TAG", { secret: SECRET })).status).toBe(400);
    expect((await put(SCOPE, "short", new Uint8Array([1]))).status).toBe(404);
  });
});

describe("the pairing box", () => {
  const BOX = "f".repeat(64);

  const pair = (method: string, body?: Record<string, string>) =>
    call(method === "POST" ? "/v1/pair" : `/v1/pair/${BOX}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });

  it("holds a waiting key, takes one envelope and hands it over", async () => {
    expect((await pair("POST", { box: BOX, pub: "key" })).status).toBe(204);
    expect((await pair("POST", { box: BOX, pub: "someone else" })).status).toBe(409);
    expect(await (await pair("GET")).json()).toEqual({ pub: "key" });
    expect((await pair("PUT", { envelope: "sealed" })).status).toBe(204);
    expect((await pair("PUT", { envelope: "again" })).status).toBe(409);
    expect(await (await pair("GET")).json()).toEqual({ pub: "key", envelope: "sealed" });
  });

  it("knows no box it wasn't given", async () => {
    expect((await call(`/v1/pair/${"0".repeat(64)}`)).status).toBe(404);
  });
});
