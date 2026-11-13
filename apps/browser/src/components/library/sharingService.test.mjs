// The shared Easels (components/library/sharingService.ts): the lease, the record and the website's answer.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const { fakeHttp } = await import("../../effect/testing.ts");
const { SharingEngine, SharingService, useEaselShares } = await import("./sharingService.ts");

// The Mac's side of the sharing, as a test wants it.
const fakeEngine = () => {
  const lab = {
    enabled: true,
    keys: new Map(),
    records: null,
    saved: [],
    identity: { id: "a".repeat(32), key: "b".repeat(64) },
  };

  const layer = Layer.succeed(SharingEngine)({
    enabled: () => lab.enabled,
    createIdentity: () => Effect.sync(() => lab.identity),
    readKey: (id) => Effect.sync(() => lab.keys.get(id) ?? null),
    writeKey: (id, key) =>
      Effect.sync(() => {
        lab.keys.set(id, key);

        return true;
      }),
    deleteKey: (id) =>
      Effect.sync(() => {
        lab.keys.delete(id);
      }),
    readRecords: () => lab.records,
    readCurrentRecords: () => Effect.sync(() => lab.records),
    acquireLock: () => Effect.succeed(null),
    requestNative: () => Effect.succeed(null),
    saveRecords: (json) =>
      Effect.sync(() => {
        lab.saved.push(JSON.parse(json));
        lab.records = json;
      }),
  });

  return { layer, lab };
};

const withSharing = async (use) => {
  useEaselShares.setState({ loaded: false, error: null, records: {}, busy: {} });

  const engine = fakeEngine();
  const http = fakeHttp();
  const runtime = ManagedRuntime.make(SharingService.layer.pipe(Layer.provide(Layer.mergeAll(engine.layer, http.layer))));

  try {
    await use({ lab: engine.lab, http, runtime });
  } finally {
    await runtime.dispose();
  }
};

const publish = (runtime, easelId) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sharing = yield* SharingService;

      return yield* sharing.publish(easelId, () => Effect.succeed('{"title":"A page"}'));
    }),
  );

test("a published Easel keeps its key, its record and its link", async () => {
  await withSharing(async ({ lab, http, runtime }) => {
    http.answer("https://bay.krishkalaria.in/api/easels/" + "a".repeat(32), { status: 200, ok: true, body: "{}" });

    const link = await publish(runtime, "easel-1");

    assert.match(link, /easel\/a{32}/);
    assert.equal(lab.keys.size, 1, "the key is in the keychain");
    assert.equal(lab.saved.length, 2, "the record is written before and after the upload");
    assert.equal(useEaselShares.getState().records["easel-1"].revision, 1);
  });
});

test("an Easel that is already being shared is refused", async () => {
  await withSharing(async ({ http, runtime }) => {
    http.answer("https://bay.krishkalaria.in/api/easels/" + "a".repeat(32), { status: 200, ok: true, body: "{}" });

    const first = publish(runtime, "easel-1");

    await assert.rejects(publish(runtime, "easel-1"), (error) => /already being shared/.test(error.message));
    await first;
  });
});

test("a website that refuses says what it refused", async () => {
  await withSharing(async ({ http, runtime }) => {
    http.answer("https://bay.krishkalaria.in/api/easels/" + "a".repeat(32), { status: 409, ok: false, body: "" });

    await assert.rejects(publish(runtime, "easel-1"), (error) => /newer snapshot/.test(error.message));
  });
});

test("sharing that is turned off is refused before anything is sent", async () => {
  await withSharing(async ({ lab, http, runtime }) => {
    lab.enabled = false;

    await assert.rejects(publish(runtime, "easel-1"), (error) => /disabled/.test(error.message));
    assert.equal(http.requests.length, 0);
  });
});
