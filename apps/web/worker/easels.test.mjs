import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import worker from "./index.ts";
import { MAX_BODY_BYTES } from "./payload.ts";

const ID = "a".repeat(32);
const KEY = "b".repeat(64);
const OTHER_KEY = "c".repeat(64);
const ORIGIN = "https://bay.example";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
const snapshot = (extra = {}) => ({
  version: 1,
  revision: 1,
  title: "Weekend ideas",
  background: "#f1e5cc",
  image: { data: PNG, width: 1, height: 1 },
  links: [{ title: "A source", url: "https://example.com/article?q=1&other=2" }],
  ...extra,
});

class FakeR2 {
  objects = new Map();
  writes = 0;
  beforePut;
  async head(key) {
    const object = this.objects.get(key);
    return object ? { etag: object.etag, customMetadata: { ...object.customMetadata } } : null;
  }
  async get(key) {
    const object = this.objects.get(key);
    return object ? { ...(await this.head(key)), text: async () => object.body } : null;
  }
  async put(key, body, options) {
    await this.beforePut?.(key, body, options);
    // Match R2's atomic condition check and content-derived ETag, including identical PUTs.
    const object = this.objects.get(key);
    const condition = options.onlyIf;
    if (condition.etagDoesNotMatch === "*" && object) return null;
    if (condition.etagMatches && condition.etagMatches !== object?.etag) return null;
    const saved = {
      body,
      etag: createHash("md5").update(body).digest("hex"),
      customMetadata: { ...options.customMetadata },
    };
    this.objects.set(key, saved);
    this.writes++;
    return this.head(key);
  }
}

function setup() {
  const bucket = new FakeR2();
  const limiterKeys = [];
  const env = {
    BAY_EASEL_WEB_SHARING: "true",
    EASELS: bucket,
    ASSETS: { fetch: async () => new Response("static asset") },
    EASEL_MUTATIONS: {
      limit: async ({ key }) => {
        limiterKeys.push(key);
        return { success: true };
      },
    },
  };
  const send = (method, body, { key = KEY, path = `/api/easels/${ID}`, headers = {} } = {}) =>
    worker.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  const page = (method = "GET", id = ID) => send(method, undefined, { path: `/easel/${id}/` });
  return { bucket, env, send, page, limiterKeys };
}

test("web sharing stays off unless explicitly true, with no R2 or rate limiter required", async () => {
  for (const flag of [undefined, "false", "0", "TRUE", "1", ""]) {
    const env = { BAY_EASEL_WEB_SHARING: flag, ASSETS: { fetch: async () => new Response("static asset") } };
    for (const [method, path] of [
      ["PUT", `/api/easels/${ID}`],
      ["DELETE", `/api/easels/${ID}`],
      ["GET", `/easel/${ID}/`],
      ["HEAD", `/easel/${ID}/`],
    ]) {
      const response = await worker.fetch(new Request(`${ORIGIN}${path}`, { method }), env);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.equal(await (await worker.fetch(new Request(ORIGIN), env)).text(), "static asset");
  }
});

test("default deployment has sharing off and no R2 bindings", async () => {
  const text = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").replace(/,\s*([}\]])/g, "$1"));
  assert.equal(config.vars.BAY_EASEL_WEB_SHARING, "false");
  assert.equal(config.r2_buckets, undefined);
  assert.equal(config.ratelimits, undefined);
  assert.equal(config.env.easels.vars.BAY_EASEL_WEB_SHARING, "true");
  assert.equal(config.env.easels.r2_buckets[0].binding, "EASELS");
});

test("publishes a persisted PNG snapshot, renders sources, and preserves static assets", async () => {
  const { send, page, bucket, env } = setup();
  assert.equal((await send("PUT", snapshot())).status, 200);
  assert.equal(bucket.writes, 1);
  const object = bucket.objects.get(`easels/${ID}`);
  assert.equal(object.customMetadata.ownerHash, createHash("sha256").update(KEY).digest("hex"));
  assert.equal(object.customMetadata.state, "published");
  assert.equal(object.body.includes(KEY), false);
  const response = await page();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Weekend ideas/);
  assert.match(html, /Shared snapshot/);
  assert.match(html, /<h2>Sources<\/h2>/);
  assert.ok(html.includes(PNG));
  assert.match(html, /rel="noreferrer noopener nofollow"/);
  assert.match(html, /href="\/" rel="noreferrer">Bay/);
  assert.ok(!html.includes(KEY) && !html.includes(object.customMetadata.ownerHash));
  assert.doesNotMatch(html, /<script|posthog|https?:\/\/[^" ]+\.(css|js)/i);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'; style-src 'unsafe-inline'; img-src data:/);
  const head = await page("HEAD");
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("content-type"), response.headers.get("content-type"));
  assert.equal(await (await worker.fetch(new Request(`${ORIGIN}/about/`), env)).text(), "static asset");
});

test("owner can update; public id and other credentials cannot edit or revoke", async () => {
  const { send, page, bucket } = setup();
  await send("PUT", snapshot());
  assert.equal((await send("PUT", snapshot({ title: "Updated", revision: 2 }))).status, 200);
  assert.match(await (await page()).text(), /Updated/);
  const writes = bucket.writes;
  for (const method of ["PUT", "DELETE"]) {
    assert.equal((await send(method, method === "PUT" ? snapshot() : undefined, { key: OTHER_KEY })).status, 403);
    assert.equal((await send(method, undefined, { headers: { Authorization: "" } })).status, 401);
    assert.equal((await send(method, undefined, { key: KEY.toUpperCase() })).status, 401);
  }
  assert.equal(bucket.writes, writes);
});

test("escapes titles and URL attributes without permitting scripts or local/private metadata", async () => {
  const { send, page, bucket } = setup();
  const attack = '<script>alert("x")</script>&\'"';
  const data = snapshot({ title: attack, links: [{ title: attack, url: 'https://example.com/?q="<tag>' }] });
  assert.equal((await send("PUT", data)).status, 200);
  const html = await (await page()).text();
  assert.doesNotMatch(html, /<script|<tag>|alert\("x"\)/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /q=&quot;&lt;tag&gt;/);
  const writes = bucket.writes;
  const invalid = [
    { ...snapshot(), profileId: "private-profile" },
    { ...snapshot(), id: ID },
    { ...snapshot(), key: KEY },
    snapshot({ links: [{ title: "x", url: "file:///Users/private/image.png" }] }),
    snapshot({ links: [{ title: "x", url: "javascript:alert(1)" }] }),
    snapshot({ links: [{ title: "x", url: "data:text/html,hello" }] }),
    snapshot({ links: [{ title: "x", url: "https://user:password@example.com" }] }),
    snapshot({ links: [{ title: "x", url: "https://example.com", tabId: "private" }] }),
    snapshot({ links: [{ title: "x", url: "https://example.com\n/x" }] }),
    snapshot({ links: [{ title: "x", url: "https://example.com\\@elsewhere.test" }] }),
    snapshot({ background: "#fff; background:url(https://evil.test)" }),
    snapshot({ version: 2 }),
    snapshot({ title: 42 }),
    snapshot({ image: { data: "data:image/svg+xml;base64,PHN2Zz4=", width: 1, height: 1 } }),
    snapshot({ image: { data: "data:image/png;base64,PHN2Zz4=", width: 1, height: 1 } }),
    snapshot({ image: { data: PNG, width: 2, height: 1 } }),
    snapshot({ image: { data: PNG, width: 1, height: 1, path: "/Users/private/image.png" } }),
  ];
  for (const value of invalid) assert.equal((await send("PUT", value)).status, 400);
  assert.equal(bucket.writes, writes);
});

test("null image and empty sources render an accessible empty snapshot", async () => {
  const { send, page } = setup();
  assert.equal((await send("PUT", snapshot({ title: "", image: null, links: [] }))).status, 200);
  const html = await (await page()).text();
  assert.match(html, /Untitled Easel/);
  assert.match(html, /No sources in this snapshot/);
});

test("bounded streaming body rejects oversized chunked/lying-length UTF-8 requests and cancels input", async () => {
  const { env, bucket } = setup();
  for (const declared of [undefined, "1"]) {
    let cancelled = false;
    const bytes = new TextEncoder().encode("é".repeat(512 * 1024));
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(bytes);
      },
      cancel() {
        cancelled = true;
      },
    });
    const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
    if (declared) headers["Content-Length"] = declared;
    const response = await worker.fetch(
      new Request(`${ORIGIN}/api/easels/${ID}`, {
        method: "PUT",
        body: stream,
        duplex: "half",
        headers,
      }),
      env,
    );
    assert.equal(response.status, 413);
    assert.equal(cancelled, true);
  }
  assert.equal(bucket.writes, 0);
  const json = JSON.stringify(snapshot({ image: null }));
  const body = json + " ".repeat(MAX_BODY_BYTES - Buffer.byteLength(json));
  const response = await worker.fetch(
    new Request(`${ORIGIN}/api/easels/${ID}`, {
      method: "PUT",
      body,
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    }),
    env,
  );
  assert.equal(response.status, 200, "exactly 16 MiB is accepted");
});

test("rejects malformed JSON, invalid UTF-8, wrong media types, and excessive declared size", async () => {
  const { env, bucket, send } = setup();
  assert.equal((await send("PUT", snapshot(), { headers: { "Content-Length": String(MAX_BODY_BYTES + 1) } })).status, 413);
  assert.equal((await send("PUT", snapshot(), { headers: { "Content-Type": "text/plain" } })).status, 415);
  for (const body of ["{bad json", new Uint8Array([0xff])]) {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/api/easels/${ID}`, {
        method: "PUT",
        body,
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      }),
      env,
    );
    assert.equal(response.status, 400);
  }
  assert.equal(bucket.writes, 0);
});

test("rejects cross-origin browser mutations, accepts native and same-origin mutations, limits per IP", async () => {
  const { send, env, bucket, limiterKeys } = setup();
  for (const origin of ["https://attacker.test", "null"]) {
    assert.equal((await send("PUT", snapshot(), { headers: { Origin: origin } })).status, 403);
    assert.equal((await send("DELETE", undefined, { headers: { Origin: origin } })).status, 403);
  }
  assert.equal(bucket.writes, 0);
  assert.equal((await send("PUT", snapshot(), { headers: { Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.7" } })).status, 200);
  assert.equal(limiterKeys.at(-1), "203.0.113.7");
  const writes = bucket.writes;
  env.EASEL_MUTATIONS.limit = async () => ({ success: false });
  for (const method of ["PUT", "DELETE"]) {
    const response = await send(method, method === "PUT" ? snapshot() : undefined);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  assert.equal(bucket.writes, writes);
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(config, /"name": "EASEL_MUTATIONS"/);
  assert.match(config, /"limit": 10, "period": 60/);
  assert.match(config, /"run_worker_first": \["\/easel\/\*", "\/api\/easels\/\*"\]/);
});

test("revoke removes content, retains owner tombstone, is idempotent, and cannot republish", async () => {
  const { send, bucket, page } = setup();
  await send("PUT", snapshot());
  assert.equal((await send("DELETE")).status, 204);
  const tombstone = bucket.objects.get(`easels/${ID}`);
  assert.equal(tombstone.body, "");
  assert.equal(tombstone.customMetadata.state, "revoked");
  assert.equal(tombstone.customMetadata.ownerHash.length, 64);
  const writes = bucket.writes;
  assert.equal((await send("DELETE")).status, 204);
  assert.equal(bucket.writes, writes);
  assert.equal((await send("PUT", snapshot())).status, 410);
  assert.equal((await send("DELETE", undefined, { key: OTHER_KEY })).status, 403);
  assert.equal((await page()).status, 404);
  assert.equal((await page("HEAD")).status, 404);
  assert.equal(await (await page("HEAD")).text(), "");
  assert.equal((await page("GET", "d".repeat(32))).status, 404);
});

test("DELETE of a missing id writes an authenticated tombstone", async () => {
  const { send, bucket } = setup();
  assert.equal((await send("DELETE", undefined, { headers: { Authorization: "" } })).status, 401);
  assert.equal(bucket.writes, 0);
  assert.equal((await send("DELETE")).status, 204);
  assert.equal((await send("DELETE")).status, 204);
  assert.equal((await send("PUT", snapshot())).status, 410);
  assert.equal((await send("PUT", snapshot(), { key: OTHER_KEY })).status, 403);
});

function pauseNextPut(bucket, predicate) {
  let resume;
  let reached;
  const ready = new Promise((resolve) => {
    reached = resolve;
  });
  const gate = new Promise((resolve) => {
    resume = resolve;
  });
  bucket.beforePut = async (_key, body) => {
    if (!predicate(body)) return;
    bucket.beforePut = undefined;
    reached();
    await gate;
  };
  return { ready, resume: () => resume() };
}

for (const existing of [false, true]) {
  test(`concurrent revoke beats paused ${existing ? "update" : "initial publish"} without resurrection`, async () => {
    const { send, bucket, page } = setup();
    if (existing) await send("PUT", snapshot());
    const pause = pauseNextPut(bucket, (body) => body !== "");
    const publishing = send("PUT", snapshot({ title: "In-flight change", revision: existing ? 2 : 1 }));
    await pause.ready;
    assert.equal((await send("DELETE")).status, 204);
    pause.resume();
    assert.equal((await publishing).status, 410);
    assert.equal((await page()).status, 404);
    assert.equal(bucket.objects.get(`easels/${ID}`).body, "");
  });
}

test("revoke retries if a concurrent update wins first, including identical-content ETags", async () => {
  const { send, bucket, page } = setup();
  await send("PUT", snapshot());
  const pause = pauseNextPut(bucket, (body) => body === "");
  const revoking = send("DELETE");
  await pause.ready;
  assert.equal((await send("PUT", snapshot({ title: "Another update", revision: 2 }))).status, 200);
  pause.resume();
  assert.equal((await revoking).status, 204);
  assert.equal((await page()).status, 404);
  assert.equal((await send("PUT", snapshot())).status, 410);
});

test("simultaneous first publishers cannot overwrite another owner's claim", async () => {
  const { send, bucket } = setup();
  const pause = pauseNextPut(bucket, () => true);
  const publishing = send("PUT", snapshot());
  await pause.ready;
  assert.equal((await send("PUT", snapshot({ title: "Other owner" }), { key: OTHER_KEY })).status, 200);
  pause.resume();
  assert.equal((await publishing).status, 403);
  assert.equal(bucket.writes, 1);
});

for (const existing of [false, true]) {
  test(`an older delayed ${existing ? "update" : "first publish"} cannot overwrite a newer snapshot`, async () => {
    const { send, bucket, page } = setup();
    if (existing) await send("PUT", snapshot());
    const pause = pauseNextPut(bucket, () => true);
    const older = send("PUT", snapshot({ title: "Old snapshot", revision: existing ? 2 : 1 }));
    await pause.ready;
    const newer = snapshot({ title: "New snapshot", revision: 3 });
    assert.equal((await send("PUT", newer)).status, 200);
    pause.resume();
    assert.equal((await older).status, 409);
    assert.match(await (await page()).text(), /New snapshot/);
    const writes = bucket.writes;
    assert.equal((await send("PUT", newer)).status, 200, "identical revision retries are idempotent");
    assert.equal(bucket.writes, writes);
    assert.equal((await send("PUT", snapshot({ title: "Different content", revision: 3 }))).status, 409);
    assert.equal(bucket.writes, writes);
  });
}

test("invalid routes and methods never mutate storage", async () => {
  const { send, bucket } = setup();
  for (const path of [`/api/easels/${ID.toUpperCase()}`, `/api/easels/short`, `/api/easels/${ID}/`]) {
    assert.equal((await send("PUT", snapshot(), { path })).status, 404);
  }
  assert.equal((await send("POST", snapshot())).status, 405);
  assert.equal((await send("GET")).status, 405);
  assert.equal((await send("PUT", snapshot(), { path: `/easel/${ID}/` })).status, 405);
  assert.equal((await send("GET", undefined, { path: `/easel/${ID}` })).status, 404);
  assert.equal(bucket.writes, 0);
});

test("storage and limiter failures return safe 503 messages", async () => {
  for (const operation of ["head", "put", "get"]) {
    const { env, send, page } = setup();
    env.EASELS[operation] = async () => {
      throw new Error(`secret R2 failure ${KEY}`);
    };
    const response = await (operation === "get" ? page() : send("PUT", snapshot()));
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /secret|R2|bbbb/);
  }
  const { env, send } = setup();
  env.EASEL_MUTATIONS.limit = async () => {
    throw new Error("binding failure");
  };
  assert.equal((await send("DELETE")).status, 503);
});
