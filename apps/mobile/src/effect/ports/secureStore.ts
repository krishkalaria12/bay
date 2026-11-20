// The app's secure store: the keychain on iOS and the keystore on Android. It holds what must not reach the disk in
// the clear, like saved logins. The native module is loaded inside the calls, so this file stays importable where
// Expo is not.
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Operation } from "../errors.ts";

/** A secret that could not be read, written or forgotten. */
export class SecureStoreError extends TaggedError("SecureStoreError")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** The native module, loaded when a secret is first needed. */
const secureStore = () => import("expo-secure-store");

/** Runs one secret operation, naming it when it fails. */
const withSecrets = <A>(operation: Operation, use: (store: typeof import("expo-secure-store")) => Promise<A>) =>
  Effect.tryPromise({
    try: async () => use(await secureStore()),
    catch: (cause) => new SecureStoreError({ operation, cause }),
  });

export class SecureStore extends Context.Service<
  SecureStore,
  {
    /** Reads a secret. It is null when there isn't one. */
    readonly read: (key: string) => Effect.Effect<string | null, SecureStoreError>;
    /** Writes a secret, replacing the one that was there. */
    readonly write: (key: string, value: string) => Effect.Effect<void, SecureStoreError>;
    /** Forgets a secret. Forgetting one that isn't there is not a failure. */
    readonly delete: (key: string) => Effect.Effect<void, SecureStoreError>;
  }
>()("bay/SecureStore") {
  static readonly layer = Layer.succeed(SecureStore)({
    read: (key) => withSecrets({ name: "secureStore.read", resource: key }, (store) => store.getItemAsync(key)),
    write: (key, value) => withSecrets({ name: "secureStore.write", resource: key }, (store) => store.setItemAsync(key, value)),
    delete: (key) => withSecrets({ name: "secureStore.delete", resource: key }, (store) => store.deleteItemAsync(key)),
  });
}
