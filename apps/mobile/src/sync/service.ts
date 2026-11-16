// The phone's sync, running: the chain's key in the secure store, the cycle's state in the app's documents, a cycle
// every half minute while Bay is in front and a few seconds after a change, and joining by a code or the recovery
// phrase. The cycle itself is engine.ts; what the screens show is state.ts.
import { phraseEntropy, type PhraseProblem } from "@bay/sync/src/relay/phrase.ts";
import { Waiting } from "@bay/sync/src/relay/pairing.ts";
import { SyncKeys, type Random } from "@bay/sync/src/relay/keys.ts";
import { base32, base64, fromBase64 } from "@bay/sync/src/relay/bytes.ts";
import { DEFAULT_RELAY, relayTransport, RelayError } from "@bay/sync/src/relay/transport.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as v from "valibot";

import { BrowserState } from "../effect/ports/browserState.ts";
import { Diagnostics } from "../effect/ports/diagnostics.ts";
import { Files } from "../effect/ports/files.ts";
import { Lifecycle, type AppStatus } from "../effect/ports/lifecycle.ts";
import { SecureStore } from "../effect/ports/secureStore.ts";
import { HISTORY_LIMIT } from "../store/model.ts";
import type { BrowserData } from "../store/types.ts";
import { newDoc, remoteTabs, runCycle, syncedDevices, type SyncDoc, type SyncTypes } from "./engine.ts";
import { useSyncStore } from "./state.ts";

/** The chain's key, base64, in the secure store. */
const KEY = "bay.sync.key";

/** The cycle's state, in the app's documents. */
const DOC = "sync/state.json";

/** How often the phone syncs while Bay is in front, and how long after a change. */
const CYCLE_MS = 30_000;
const AFTER_CHANGE_MS = 3_000;

/** How often a waiting pairing asks whether its envelope has come. */
const POLL_MS = 2_000;

const ScopeSchema = v.looseObject({});

const DocSchema = v.object({
  v: v.literal(1),
  deviceId: v.string(),
  clock: v.nullable(v.string()),
  profile: v.nullable(v.string()),
  scopes: v.record(v.string(), ScopeSchema),
  types: v.object({ tabs: v.boolean(), bookmarks: v.boolean(), history: v.boolean() }),
  lastSyncedAt: v.nullable(v.number()),
});

export interface SyncPlatform {
  random: Random;
  deviceName: () => string;
  /** The computer's bookmarks bar, as the phone names its folder. */
  barTitle: () => string;
}

export class PhoneSync extends Context.Service<
  PhoneSync,
  {
    /** Loads the key and the state and starts the cycles; runs on the app scope. */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    /** Shows a code and waits under it for a computer to let this phone in. */
    readonly pair: Effect.Effect<void>;
    readonly cancelPairing: Effect.Effect<void>;
    /** Joins with the recovery phrase, or says why the phrase doesn't read. */
    readonly joinWithPhrase: (text: string) => Effect.Effect<PhraseProblem | null>;
    readonly syncNow: Effect.Effect<void>;
    readonly setType: (type: keyof SyncTypes, on: boolean) => Effect.Effect<void>;
    /** Takes this phone out of the chain and forgets the key; what it synced stays. */
    readonly leave: Effect.Effect<void>;
  }
>()("bay/PhoneSync") {
  static readonly layer = (platform: SyncPlatform) =>
    Layer.effect(
      PhoneSync,
      Effect.gen(function* () {
        const files = yield* Files;
        const secureStore = yield* SecureStore;
        const browserState = yield* BrowserState;
        const lifecycle = yield* Lifecycle;
        const diagnostics = yield* Diagnostics;
        const kicks = yield* Queue.sliding<void>(1);
        let keys: SyncKeys | null = null;
        let doc: SyncDoc | null = null;
        let active = true;
        let running = false;

        const show = (update: Partial<ReturnType<typeof useSyncStore.getState>>) => useSyncStore.setState(update);

        const publish = () => {
          if (!doc) return show({ status: "off", devices: [], remoteTabs: [], lastSyncedAt: null });

          show({ devices: syncedDevices(doc), remoteTabs: remoteTabs(doc), types: doc.types, lastSyncedAt: doc.lastSyncedAt });
        };

        const save = (next: SyncDoc) =>
          Effect.gen(function* () {
            yield* files.createDirectory("document", "sync");
            // Written aside, then moved over: a crash mid-write leaves the last whole state.
            yield* files.write("document", `${DOC}.tmp`, JSON.stringify(next));
            yield* files.move("document", `${DOC}.tmp`, DOC);
          });

        const load = Effect.gen(function* () {
          const stored = yield* secureStore.read(KEY);

          if (!stored) return;

          const text = yield* files.read("document", DOC);
          const parsed = text ? v.safeParse(DocSchema, JSON.parse(text)) : null;

          keys = new SyncKeys(fromBase64(stored), platform.random);
          // SAFETY: the scopes were written by save() from ScopeState values the cycle keeps.
          doc = parsed?.success ? (parsed.output as SyncDoc) : newDoc(base32(platform.random(16)));
        });

        /** One cycle, if the phone syncs and Bay is in front; a cycle under way already is enough. */
        const cycle = (force: boolean) =>
          Effect.gen(function* () {
            if (!keys || !doc || running || (!active && !force)) return;

            running = true;
            show({ status: "syncing" });

            const current = doc;
            const transport = relayTransport({ keys, url: DEFAULT_RELAY });
            const dispatch = yield* browserState.dispatcher();
            let data: BrowserData = yield* browserState.data();
            const ready = yield* browserState.ready();

            const result = yield* Effect.tryPromise({
              try: () =>
                runCycle(current, {
                  transport,
                  deviceName: platform.deviceName,
                  data: () => data,
                  ready: () => ready,
                  dispatch: (action) => {
                    dispatch(action);
                    data = Effect.runSync(Effect.orElseSucceed(browserState.data(), () => data));
                  },
                  barTitle: platform.barTitle,
                  historyLimit: HISTORY_LIMIT,
                  save: (next) => Effect.runPromise(Effect.orDie(save(next))),
                }),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            }).pipe(
              Effect.matchEffect({
                onSuccess: (outcome) => Effect.succeed(outcome.profile ? ("synced" as const) : ("waiting" as const)),
                onFailure: (cause) =>
                  cause instanceof RelayError && cause.status === 0
                    ? Effect.succeed("offline" as const)
                    : Effect.as(diagnostics.report({ operation: { name: "sync.cycle" }, message: "Sync didn't finish.", cause }), "failed" as const),
              }),
              Effect.ensuring(Effect.sync(() => void (running = false))),
            );

            show({ status: doc ? result : "off" });
            publish();
          }).pipe(Effect.catch(() => Effect.void));

        /** Starts syncing with a chain's key: from a code or the phrase. */
        const join = (entropy: Uint8Array) =>
          Effect.gen(function* () {
            yield* secureStore.write(KEY, base64(entropy));
            keys = new SyncKeys(entropy, platform.random);
            doc = newDoc(base32(platform.random(16)));
            yield* save(doc);
            publish();
            yield* cycle(true);
          });

        const pairing = yield* FiberHandle.make();

        const waitForKey = (waiting: Waiting): Effect.Effect<void> =>
          Effect.gen(function* () {
            for (;;) {
              yield* Effect.sleep(POLL_MS);

              const answer = yield* Effect.tryPromise(() => waiting.poll()).pipe(Effect.orElseSucceed(() => null));

              if (answer && "expired" in answer) return show({ pairing: { state: "expired" } });

              if (answer && "entropy" in answer) {
                show({ pairing: null });

                return yield* join(answer.entropy).pipe(Effect.catch(() => Effect.sync(() => show({ pairing: { state: "failed" } }))));
              }
            }
          });

        return PhoneSync.of({
          start: Effect.gen(function* () {
            const run = yield* FiberSet.runtime(yield* FiberSet.make())<never>();

            yield* load.pipe(Effect.catch(() => Effect.void));
            publish();

            yield* lifecycle.onChange((status: AppStatus) => {
              active = status === "active";

              if (active) Queue.offerUnsafe(kicks, undefined);
            });

            // A change to what syncs: a cycle a moment later, once a burst of changes has settled.
            let timer: ReturnType<typeof setTimeout> | undefined;

            yield* browserState.subscribe((data, previous) => {
              if (data.tabs === previous.tabs && data.history === previous.history && data.bookmarks === previous.bookmarks) return;

              clearTimeout(timer);
              timer = setTimeout(() => Queue.offerUnsafe(kicks, undefined), AFTER_CHANGE_MS);
            });

            run(
              Effect.forever(
                Effect.gen(function* () {
                  yield* cycle(false);
                  yield* Effect.raceFirst(Queue.take(kicks), Effect.sleep(CYCLE_MS));
                }),
              ),
            );
          }),
          pair: Effect.gen(function* () {
            show({ pairing: { state: "starting" } });

            const waiting = yield* Effect.tryPromise(() => Waiting.start({ url: DEFAULT_RELAY, random: platform.random })).pipe(
              Effect.orElseSucceed(() => null),
            );

            if (!waiting) return show({ pairing: { state: "failed" } });

            show({ pairing: { state: "waiting", code: waiting.code, digits: waiting.digits } });
            yield* FiberHandle.run(pairing, waitForKey(waiting));
          }),
          cancelPairing: Effect.andThen(
            FiberHandle.clear(pairing),
            Effect.sync(() => show({ pairing: null })),
          ),
          joinWithPhrase: (text) =>
            Effect.gen(function* () {
              const read = phraseEntropy(text);

              if ("problem" in read) return read.problem;

              yield* join(read.entropy).pipe(Effect.orDie);

              return null;
            }),
          syncNow: cycle(true),
          setType: (type, on) =>
            Effect.gen(function* () {
              if (!doc) return;

              doc.types = { ...doc.types, [type]: on };
              yield* save(doc).pipe(Effect.catch(() => Effect.void));
              publish();
              Queue.offerUnsafe(kicks, undefined);
            }),
          leave: Effect.gen(function* () {
            const current = doc;
            const currentKeys = keys;

            // The phone's name and tabs leave the chain first, if the relay answers; the key goes either way.
            if (current && currentKeys) {
              const dispatch = yield* browserState.dispatcher();
              const data = yield* browserState.data();

              yield* Effect.tryPromise(() =>
                runCycle(
                  current,
                  {
                    transport: relayTransport({ keys: currentKeys, url: DEFAULT_RELAY }),
                    deviceName: platform.deviceName,
                    data: () => data,
                    ready: () => false,
                    dispatch,
                    barTitle: platform.barTitle,
                    historyLimit: HISTORY_LIMIT,
                    save: async () => undefined,
                  },
                  true,
                ),
              ).pipe(Effect.ignore);
            }

            keys = null;
            doc = null;
            yield* secureStore.delete(KEY).pipe(Effect.ignore);
            yield* files.delete("document", DOC).pipe(Effect.ignore);
            publish();
          }).pipe(Effect.catch(() => Effect.void)),
        });
      }),
    );
}
