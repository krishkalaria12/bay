// The saved-logins service (src/browser/credentials.ts): every change to the one secure-store document takes its
// turn, so two changes made at once both land, in the order they were asked for.
import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { forgetLogin, Logins, savedLogins } from "../src/browser/credentials.ts";
import { parseSavedLogins, type SavedLogin } from "../src/browser/logins.ts";
import { SecureStore, SecureStoreError } from "../src/effect/ports/secureStore.ts";
import { fakeDiagnostics, fakeSecureStore } from "../src/effect/testing.ts";

const KEY = "bay-saved-logins";

const login = (origin: string, username: string, password = "secret"): SavedLogin => ({ origin, username, password, savedAt: 1 });

/** A secure store that takes its time over every read and write, as the keychain does, so changes can overlap. */
const slowSecureStore = () => {
  const values = new Map<string, string>();
  const pause = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));

  return {
    layer: Layer.succeed(SecureStore)({
      read: (key) => Effect.map(pause, () => values.get(key) ?? null),
      write: (key, value) => Effect.map(pause, () => void values.set(key, value)),
      delete: (key) => Effect.map(pause, () => void values.delete(key)),
    }),
    values,
  };
};

const run = <A, E>(program: Effect.Effect<A, E, Logins>, store: Layer.Layer<SecureStore>) =>
  Effect.runPromise(program.pipe(Effect.provide(Logins.layer.pipe(Layer.provide(store)))));

test("two saves made at once keep both logins", async () => {
  const store = slowSecureStore();

  await run(
    Effect.gen(function* () {
      const logins = yield* Logins;

      yield* Effect.all([logins.save(login("https://a.example", "ana")), logins.save(login("https://b.example", "ben"))], { concurrency: "unbounded" });
    }),
    store.layer,
  );

  const saved = parseSavedLogins(store.values.get(KEY) ?? null);

  assert.deepEqual(
    saved.map((entry) => entry.username),
    ["ana", "ben"],
  );
});

test("a forget asked for during a save lands after it", async () => {
  const store = slowSecureStore();

  await run(
    Effect.gen(function* () {
      const logins = yield* Logins;

      yield* logins.save(login("https://a.example", "ana"));

      const saving = yield* Effect.forkChild(logins.save(login("https://b.example", "ben")));

      yield* Effect.yieldNow;

      const forgetting = yield* Effect.forkChild(logins.forget("https://b.example", "ben"));

      yield* Fiber.join(saving);
      yield* Fiber.join(forgetting);
    }),
    store.layer,
  );

  const saved = parseSavedLogins(store.values.get(KEY) ?? null);

  assert.deepEqual(
    saved.map((entry) => entry.username),
    ["ana"],
    "the forget ran after the save it overlapped, so the login stays forgotten",
  );
});

test("saving again for the same site and user replaces the login, and find reads it back", async () => {
  const store = fakeSecureStore();

  const found = await run(
    Effect.gen(function* () {
      const logins = yield* Logins;

      yield* logins.save(login("https://a.example", "ana", "old"));
      yield* logins.save(login("https://a.example", "ana", "new"));

      return yield* logins.find("https://a.example");
    }),
    store.layer,
  );

  assert.equal(found?.password, "new");
  assert.equal(parseSavedLogins(store.values.get(KEY) ?? null).length, 1);
});

test("Settings' forget reads the list back, and a failed forget is reported with the list still shown", async () => {
  const diagnostics = fakeDiagnostics();
  const values = new Map<string, string>([[KEY, JSON.stringify([login("https://a.example", "ana")])]]);

  const refusing = Layer.succeed(SecureStore)({
    read: (key) => Effect.succeed(values.get(key) ?? null),
    write: (key) => Effect.fail(new SecureStoreError({ operation: { name: "secureStore.write", resource: key }, cause: new Error("the keychain refused") })),
    delete: () => Effect.void,
  });

  const listed = await Effect.runPromise(
    forgetLogin("https://a.example", "ana").pipe(Effect.provide(Layer.mergeAll(Logins.layer.pipe(Layer.provide(refusing)), diagnostics.layer))),
  );

  assert.deepEqual(
    listed.map((entry) => entry.username),
    ["ana"],
    "the list shows what is really saved",
  );
  assert.equal(diagnostics.reports.length, 1, "the failed forget is reported once");

  const store = fakeSecureStore();

  store.values.set(KEY, JSON.stringify([login("https://a.example", "ana"), login("https://b.example", "ben")]));

  const after = await Effect.runPromise(
    forgetLogin("https://a.example", "ana").pipe(Effect.provide(Layer.mergeAll(Logins.layer.pipe(Layer.provide(store.layer)), diagnostics.layer))),
  );

  assert.deepEqual(
    after.map((entry) => entry.username),
    ["ben"],
  );

  const listedAgain = await Effect.runPromise(savedLogins.pipe(Effect.provide(Logins.layer.pipe(Layer.provide(store.layer)))));

  assert.deepEqual(
    listedAgain.map((entry) => entry.username),
    ["ben"],
  );
});
