// Sync over the relay, against a stand-in that answers as apps/sync-relay does: files sealed, kept and read back;
// pairing a phone by a code; and one chain read by a computer on its folder and the relay, a phone on the relay and a
// computer on the folder alone.
import assert from "node:assert/strict";
import test from "node:test";
import * as v from "valibot";

import type { JsonValue } from "../canon.ts";
import { Clock } from "../hlc.ts";
import { emptyScope, syncScope, type Adapter, type Listing } from "../scope.ts";
import { base64, fromBase64 } from "./bytes.ts";
import { SyncKeys } from "./keys.ts";
import { mirrorTransport, type MirrorState, type NamedTransport } from "./mirror.ts";
import { formatCode, isCode, Joining, normalizeCode, Waiting } from "./pairing.ts";
import { relayTransport, type Fetch } from "./transport.ts";

const URL_ = "https://relay.test";

const IdsSchema = v.object({ ids: v.array(v.string()) });
const WaitSchema = v.object({ box: v.string(), pub: v.string() });
const EnvelopeSchema = v.object({ envelope: v.string() });

/** The relay in memory: its chains, their claims and files, and the pairing boxes. */
function standInRelay() {
  const chains = new Map<string, { secret: string; files: Map<string, Uint8Array> }>();
  const boxes = new Map<string, { pub: string; envelope?: string }>();
  const reply = (status: number, body?: JsonValue) => new Response(body === undefined ? null : JSON.stringify(body), { status });

  const fetcher: Fetch = async (input, init = {}) => {
    const path = new URL(input).pathname;
    const method = init.method ?? "GET";
    const bodyText = v.is(v.string(), init.body) ? init.body : "";

    if (path === "/v1/pair" && method === "POST") {
      const body = v.parse(WaitSchema, JSON.parse(bodyText));

      if (boxes.has(body.box)) return reply(409, { error: "taken" });

      boxes.set(body.box, { pub: body.pub });

      return reply(204);
    }

    const pair = /^\/v1\/pair\/(\w+)$/.exec(path);

    if (pair) {
      const box = boxes.get(pair[1]!);

      if (!box) return reply(404, { error: "not-found" });

      if (method === "PUT") {
        if (box.envelope) return reply(409, { error: "taken" });

        box.envelope = v.parse(EnvelopeSchema, JSON.parse(bodyText)).envelope;

        return reply(204);
      }

      return reply(200, box.envelope ? { pub: box.pub, envelope: box.envelope } : { pub: box.pub });
    }

    const [, chainTag = "", , scope = "", action = "", id = ""] = /^\/v1\/chains\/(\w+)(\/scopes\/(\w+)(?:\/(\w+)(?:\/(\w+))?)?)?$/.exec(path) ?? [];
    const secret = new Headers(init.headers).get("authorization") ?? "";
    const chain = chains.get(chainTag);

    if (chain && chain.secret !== secret) return reply(403, { error: "auth" });

    if (!scope) return chain ? reply(200, { version: chain.files.size, size: 0 }) : reply(404, { error: "none" });

    const files = chain?.files ?? new Map<string, Uint8Array>();
    const key = (name: string) => `${scope}/${name}`;

    if (action === "files" && method === "PUT") {
      const stored = chain ?? { secret, files };

      chains.set(chainTag, stored);

      if (!stored.files.has(key(id)) && init.body instanceof Uint8Array) stored.files.set(key(id), init.body);

      return reply(204);
    }

    if (action === "read") {
      const { ids } = v.parse(IdsSchema, JSON.parse(bodyText));
      const found = ids.filter((name) => files.has(key(name)));

      return reply(200, {
        files: found.map((name) => ({ id: name, data: base64(files.get(key(name))!) })),
        missing: ids.filter((name) => !files.has(key(name))),
        later: [],
      });
    }

    if (action === "remove") {
      for (const name of v.parse(IdsSchema, JSON.parse(bodyText)).ids) files.delete(key(name));

      return reply(204);
    }

    const ids = [...files.keys()].flatMap((name) => (name.startsWith(`${scope}/`) ? [name.slice(scope.length + 1)] : []));

    return reply(200, { ids: ids.sort(), version: files.size });
  };

  return { fetcher, chains, boxes };
}

/** A folder in memory that can write under a given name, as the native folder transport will. */
function folderTransport(files = new Map<string, string>()): NamedTransport & { files: Map<string, string> } {
  let counter = 0;
  const key = (scope: string, id: string) => `${scope}/${id}`;

  return {
    files,
    write: async (scope, payload) => {
      // A tag-shaped name, its number written in letters.
      const id = `folder${[...String(++counter).padStart(20, "0")].map((digit) => "abcdefghij"[Number(digit)]).join("")}`;

      files.set(key(scope, id), payload);

      return id;
    },
    writeAs: async (scope, id, payload) => void files.set(key(scope, id), payload),
    read: async (scope, known): Promise<Listing> => {
      const listing: Listing = { files: [], pending: [], damaged: [], present: [] };

      for (const [name, payload] of files) {
        if (!name.startsWith(`${scope}/`)) continue;

        const id = name.slice(scope.length + 1);

        listing.present.push(id);

        if (!known.includes(id)) listing.files.push({ id, payload });
      }

      return listing;
    },
    remove: async (scope, ids) => {
      for (const id of ids) files.delete(key(scope, id));
    },
  };
}

const entropy = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
let counter = 0;

/** Distinct random bytes, so file names don't collide between devices in a test. */
const random = (length: number) => Uint8Array.from({ length }, () => (counter = (counter * 1103515245 + 12345) & 0x7fffffff) & 0xff);

test("files go to the relay sealed, and come back to a device with the key", async () => {
  const relay = standInRelay();
  const keys = new SyncKeys(entropy, random);
  const transport = relayTransport({ keys, url: URL_, fetch: relay.fetcher });

  assert.equal(await transport.state(), null);

  const id = await transport.write("app", '{"hello":1}');
  const stored = relay.chains.get(keys.chainTag)!.files.get(`${keys.scopeTag("app")}/${id}`)!;

  // What the relay holds is sealed: the payload isn't in it.
  assert.ok(!Buffer.from(stored).toString("latin1").includes("hello"));

  const listing = await transport.read("app", []);

  assert.deepEqual(listing.files, [{ id, payload: '{"hello":1}' }]);
  assert.deepEqual((await transport.read("app", [id])).files, []);

  // Another key's device can't read the chain, nor claim it.
  const other = relayTransport({ keys: new SyncKeys(new Uint8Array(32), random), url: URL_, fetch: relay.fetcher });

  assert.equal((await other.read("app", [])).files.length, 0);

  await transport.remove("app", [id]);
  assert.deepEqual((await transport.read("app", [])).present, []);
});

test("a phone joins by its code once the digits match, and gets the chain's key", async () => {
  const relay = standInRelay();
  const phone = await Waiting.start({ url: URL_, fetch: relay.fetcher, random });

  assert.ok(isCode(phone.code));
  assert.equal(normalizeCode(formatCode(phone.code).toLowerCase()), phone.code);
  assert.equal(await phone.poll(), null);

  const mac = await Joining.find(normalizeCode(` ${formatCode(phone.code)} `), { url: URL_, fetch: relay.fetcher, random });

  assert.ok(mac instanceof Joining);
  assert.equal(mac.digits, phone.digits);

  await mac.letIn(entropy);

  const joined = await phone.poll();

  assert.ok(joined && "entropy" in joined);
  assert.deepEqual(joined.entropy, entropy);

  // A mistyped code finds no one; a key the relay swapped in fails its tag.
  assert.equal(await Joining.find("ZZZZZZZZ", { url: URL_, fetch: relay.fetcher }), "not-found");

  const intruder = await Waiting.start({ url: URL_, fetch: relay.fetcher, random });
  const box = [...relay.boxes.values()].at(-1)!;
  const posted = fromBase64(box.pub);

  posted[0]! ^= 1;
  box.pub = base64(posted);
  assert.equal(await Joining.find(intruder.code, { url: URL_, fetch: relay.fetcher }), "not-verified");
});

/** A device that syncs a map of values in one scope, as the app's adapters sync theirs. */
function device(id: string) {
  const values = new Map<string, JsonValue>();
  const state = emptyScope();
  const clock = new Clock(id);

  const adapter: Adapter = {
    prefix: "x:",
    extract: () => ({ values: new Map(values) }),
    apply: (visible, changed) => {
      for (const key of changed) {
        const value = visible.get(key);

        if (value === undefined) values.delete(key);
        else values.set(key, value);
      }
    },
  };

  return {
    values,
    sync: (transport: Parameters<typeof syncScope>[0]["transport"]) => syncScope({ scope: "app", state, transport, adapters: [adapter], clock, device: id }),
  };
}

test("a Mac on its folder and the relay carries one chain between a phone and a Mac on the folder alone", async () => {
  const relay = standInRelay();
  const folder = folderTransport();
  const keys = new SyncKeys(entropy, random);
  const mirrorState: MirrorState = {};
  const bridge = mirrorTransport(folder, relayTransport({ keys, url: URL_, fetch: relay.fetcher }), mirrorState);
  const onRelay = relayTransport({ keys: new SyncKeys(entropy, random), url: URL_, fetch: relay.fetcher });
  const mac = device("mac");
  const phone = device("phone");
  const otherMac = device("mac2");

  mac.values.set("x:mac", "from the Mac");
  phone.values.set("x:phone", "from the phone");
  otherMac.values.set("x:other", "from the other Mac");

  for (let round = 0; round < 3; round++) {
    await mac.sync(bridge);
    await phone.sync(onRelay);
    await otherMac.sync(folder);
  }

  const everything = { "x:mac": "from the Mac", "x:other": "from the other Mac", "x:phone": "from the phone" };

  for (const each of [mac, phone, otherMac]) assert.deepEqual(Object.fromEntries([...each.values].sort()), everything);

  // A removal on the phone reaches the Mac on the folder.
  phone.values.delete("x:mac");

  for (let round = 0; round < 3; round++) {
    await phone.sync(onRelay);
    await mac.sync(bridge);
    await otherMac.sync(folder);
  }

  assert.equal(otherMac.values.has("x:mac"), false);
  assert.equal(mac.values.has("x:mac"), false);
});
