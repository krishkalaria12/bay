// The shared Easels: the pages the app publishes to its website, and the keys that own them.
//
// A publication is a job: the Easel is leased while it is published, the record is written before anything is
// sent (an interrupted upload must still be able to stop sharing), and the revision only moves on once the
// website has taken it.
import * as v from "valibot";
import {
  createEaselShareIdentity,
  isEaselWebSharingEnabled,
  keychainDelete,
  keychainGet,
  keychainSet,
  readEaselShareRecords,
  saveDocument,
} from "@bay/desktop";
import { create } from "zustand";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { TaggedError } from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Http, HttpError } from "../../effect/ports/http";

const ORIGIN = "https://bay.krishkalaria.in";
const FILE = "easel-shares.json";

const account = (id: string) => `easel-share:${id}`;

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** What the app knows of a published Easel. */
export type Publication = { id: string; publishedAt: number | null; revision: number };

/** The sharing could not be done, and the app tells the user why. */
export class SharingFailure extends TaggedError("SharingFailure")<{
  readonly operation: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

type ShareState = { loaded: boolean; error: string | null; records: Record<string, Publication>; busy: Record<string, boolean> };

export const useEaselShares = create<ShareState>()(() => ({ loaded: false, error: null, records: {}, busy: {} }));

export const easelShareURL = (id: string) => `${ORIGIN}/easel/${id}/`;

/** The Mac's side of the sharing: the keychain, the records and the feature gate. */
export class SharingEngine extends Context.Service<
  SharingEngine,
  {
    readonly enabled: () => boolean;
    readonly createIdentity: () => Effect.Effect<{ id: string; key: string }, SharingFailure>;
    readonly readKey: (id: string) => Effect.Effect<string | null, SharingFailure>;
    readonly writeKey: (id: string, key: string) => Effect.Effect<boolean, SharingFailure>;
    readonly deleteKey: (id: string) => Effect.Effect<void, SharingFailure>;
    readonly readRecords: () => string | null;
    readonly saveRecords: (json: string) => Effect.Effect<void, SharingFailure>;
  }
>()("bay/SharingEngine") {
  static readonly layer = Layer.succeed(SharingEngine)({
    enabled: () => isEaselWebSharingEnabled(),
    createIdentity: () =>
      Effect.tryPromise({
        try: () => createEaselShareIdentity(),
        catch: (cause) => new SharingFailure({ operation: "sharing.identity", message: message(cause), cause }),
      }),
    readKey: (id) =>
      Effect.tryPromise({
        try: () => keychainGet(account(id)),
        catch: (cause) => new SharingFailure({ operation: "sharing.key", message: message(cause), cause }),
      }),
    writeKey: (id, key) =>
      Effect.tryPromise({
        try: () => keychainSet(account(id), key),
        catch: (cause) => new SharingFailure({ operation: "sharing.key", message: message(cause), cause }),
      }),
    deleteKey: (id) =>
      Effect.tryPromise({
        try: () => keychainDelete(account(id)),
        catch: (cause) => new SharingFailure({ operation: "sharing.key", message: message(cause), cause }),
      }),
    readRecords: () => readEaselShareRecords(),
    saveRecords: (json) =>
      Effect.tryPromise({
        try: () => saveDocument(FILE, json),
        catch: (cause) => new SharingFailure({ operation: "sharing.records", message: message(cause), cause }),
      }),
  });
}

export class SharingService extends Context.Service<
  SharingService,
  {
    /** Reads the sharing records. */
    readonly start: Effect.Effect<void>;
    /** Publishes the Easel, and gives the link to share it by. */
    readonly publish: (easelId: string, snapshot: () => Effect.Effect<string>) => Effect.Effect<string, SharingFailure>;
    /** Stops sharing the Easel. */
    readonly stop: (easelId: string) => Effect.Effect<void, SharingFailure>;
  }
>()("bay/SharingService") {
  static readonly layer = Layer.effect(
    SharingService,
    Effect.gen(function* () {
      const engine = yield* SharingEngine;
      const http = yield* Http;
      const scope = yield* Scope.Scope;

      // The records are written one at a time: a revision must not overtake the one before it.
      const writes = yield* Queue.unbounded<{
        readonly easelId: string;
        readonly value: Publication | null;
        readonly written: Deferred.Deferred<void, SharingFailure>;
      }>();

      const writeRecord = (easelId: string, value: Publication | null): Effect.Effect<void, SharingFailure> =>
        Effect.gen(function* () {
          const records = { ...useEaselShares.getState().records };

          if (value) records[easelId] = value;
          else delete records[easelId];

          yield* engine.saveRecords(JSON.stringify({ version: 1, records }));

          useEaselShares.setState({ records });
        });

      // The writer runs here, in the app's scope: the records are written in the order they were asked for.
      yield* Effect.forkIn(
        Effect.forever(
          Effect.flatMap(Queue.take(writes), (write) =>
            Effect.gen(function* () {
              const exit = yield* Effect.exit(writeRecord(write.easelId, write.value));

              if (Exit.isFailure(exit)) {
                yield* Deferred.fail(
                  write.written,
                  new SharingFailure({ operation: "sharing.records", message: message(Cause.squash(exit.cause)), cause: Cause.squash(exit.cause) }),
                );
              } else {
                yield* Deferred.succeed(write.written, undefined);
              }
            }),
          ),
        ),
        scope,
      );

      const save = (easelId: string, value: Publication | null): Effect.Effect<void, SharingFailure> =>
        Effect.gen(function* () {
          const written = yield* Deferred.make<void, SharingFailure>();

          Queue.offerUnsafe(writes, { easelId, value, written });

          yield* Deferred.await(written);
        });

      const readRecords = (): void => {
        if (useEaselShares.getState().loaded) return;

        try {
          const text = engine.readRecords();
          const data = text === null ? { version: 1, records: {} } : JSON.parse(text);

          if (data?.version !== 1 || !data.records || !v.is(v.object({}), data.records) || Array.isArray(data.records))
            throw new Error("Invalid sharing records");

          // SAFETY: Publication[]) { assertion matches the runtime value validated at this call site.
          for (const value of Object.values(data.records) as Publication[]) {
            if (
              !value ||
              !/^[a-f0-9]{32}$/.test(value.id) ||
              !Number.isSafeInteger(value.revision) ||
              value.revision < 1 ||
              (value.publishedAt !== null && !Number.isFinite(value.publishedAt))
            ) {
              throw new Error("Invalid sharing record");
            }
          }

          useEaselShares.setState({ loaded: true, records: data.records, error: null });
        } catch {
          useEaselShares.setState({ loaded: true, error: "Couldn't read Easel sharing records. Restore easel-shares.json before changing shared pages." });
        }
      };

      const start = Effect.sync(readRecords);

      // The Easel is leased while it is published: a second request is refused, not queued.
      const withLease = <A, E>(easelId: string, run: Effect.Effect<A, E>): Effect.Effect<A, E | SharingFailure> =>
        Effect.gen(function* () {
          readRecords();

          const state = useEaselShares.getState();

          if (state.error) {
            return yield* Effect.fail(new SharingFailure({ operation: "sharing.publish", message: state.error, cause: new Error(state.error) }));
          }

          if (state.busy[easelId]) {
            return yield* Effect.fail(
              new SharingFailure({
                operation: "sharing.publish",
                message: "This Easel is already being shared. Wait for it to finish.",
                cause: new Error("This Easel is already being shared. Wait for it to finish."),
              }),
            );
          }

          useEaselShares.setState({ busy: { ...state.busy, [easelId]: true } });

          return yield* Effect.onExit(run, () =>
            Effect.sync(() => {
              const busy = { ...useEaselShares.getState().busy };

              delete busy[easelId];
              useEaselShares.setState({ busy });
            }),
          );
        });

      const managementKey = (id: string): Effect.Effect<string, SharingFailure> =>
        Effect.gen(function* () {
          const key = yield* engine.readKey(id);

          if (!key || !/^[a-f0-9]{64}$/.test(key)) {
            return yield* Effect.fail(
              new SharingFailure({
                operation: "sharing.key",
                message: "The sharing key is unavailable in Keychain. Restore access to it before changing this shared page.",
                cause: new Error("The sharing key is unavailable in Keychain. Restore access to it before changing this shared page."),
              }),
            );
          }

          return yield* Effect.succeed(key);
        });

      const messages = new Map<number, string>([
        [400, "This Easel couldn't be shared. Check its source links or export it as HTML."],
        [401, "The sharing key wasn't accepted. Restore Keychain access before trying again."],
        [403, "This Mac couldn't authorize a change to the shared page. Check its sharing key in Keychain."],
        [404, "Web sharing isn't available on Bay's website yet. Export this Easel as HTML instead."],
        [409, "A newer snapshot reached the shared page first. Publish again to share your current Easel."],
        [410, "This link has been stopped. Stop sharing here, then publish a new link."],
        [413, "This Easel is too large to share. Export it as HTML instead."],
        [429, "Too many sharing requests. Wait a minute and try again."],
      ]);

      const request = (publication: Publication, method: "PUT" | "DELETE", body?: string): Effect.Effect<void, SharingFailure> =>
        Effect.gen(function* () {
          const key = yield* managementKey(publication.id);

          const sent = yield* http
            .send({
              url: `${ORIGIN}/api/easels/${publication.id}`,
              method,
              headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : undefined) },
              body,
              redirect: "error",
            })
            .pipe(Effect.timeout(Duration.millis(60_000)));

          void sent;
        }).pipe(
          Effect.catch((error) =>
            Effect.fail(new SharingFailure({ operation: "sharing.request", message: messageFor(error), cause: new Error(messageFor(error)) })),
          ),
        );

      // What the website said, in the app's words. Anything else keeps its own message.
      const messageFor = (error: HttpError | Cause.TimeoutError | Error): string => {
        if (Cause.isTimeoutError(error)) return "Sharing timed out. Retry or stop sharing to check the link's status.";

        if (error instanceof HttpError) {
          const known = messages.get(error.status);

          if (known) return known;

          // A status of zero is the network's own refusal, not the website's answer.
          if (error.status === 0) return message(error.cause);

          return `Sharing failed (${error.status}). Try again.`;
        }

        return message(error);
      };

      const publish = (easelId: string, snapshot: () => Effect.Effect<string>): Effect.Effect<string, SharingFailure> =>
        withLease(
          easelId,
          Effect.gen(function* () {
            if (!engine.enabled()) {
              return yield* Effect.fail(
                new SharingFailure({
                  operation: "sharing.publish",
                  message: "Easel web sharing is disabled.",
                  cause: new Error("Easel web sharing is disabled."),
                }),
              );
            }

            const body = yield* snapshot();
            let publication = useEaselShares.getState().records[easelId];

            if (!publication) {
              const identity = yield* engine.createIdentity();

              if (!/^[a-f0-9]{32}$/.test(identity.id) || !/^[a-f0-9]{64}$/.test(identity.key)) {
                return yield* Effect.fail(
                  new SharingFailure({
                    operation: "sharing.publish",
                    message: "Couldn't create a secure sharing link.",
                    cause: new Error("Couldn't create a secure sharing link."),
                  }),
                );
              }

              if (!(yield* engine.writeKey(identity.id, identity.key))) {
                return yield* Effect.fail(
                  new SharingFailure({
                    operation: "sharing.publish",
                    message: "Couldn't save the sharing key in Keychain. Nothing was published.",
                    cause: new Error("Couldn't save the sharing key in Keychain. Nothing was published."),
                  }),
                );
              }

              publication = { id: identity.id, publishedAt: null, revision: 0 };
            }

            if (publication.revision >= Number.MAX_SAFE_INTEGER) {
              return yield* Effect.fail(
                new SharingFailure({
                  operation: "sharing.publish",
                  message: "Stop sharing and publish a new link before updating this page.",
                  cause: new Error("Stop sharing and publish a new link before updating this page."),
                }),
              );
            }

            publication = { ...publication, revision: publication.revision + 1 };

            // The record is written before anything is sent: an interrupted upload must still be able to stop sharing.
            yield* save(easelId, publication);
            yield* request(publication, "PUT", JSON.stringify({ ...JSON.parse(body), revision: publication.revision }));
            yield* save(easelId, { ...publication, publishedAt: Date.now() });

            return yield* Effect.succeed(easelShareURL(publication.id));
          }),
        );

      const stop = (easelId: string): Effect.Effect<void, SharingFailure> =>
        withLease(
          easelId,
          Effect.gen(function* () {
            const publication = useEaselShares.getState().records[easelId];

            if (!publication) return;

            if (!engine.enabled()) {
              return yield* Effect.fail(
                new SharingFailure({
                  operation: "sharing.stop",
                  message: "Easel web sharing is disabled. Enable it before stopping sharing or deleting a shared Easel.",
                  cause: new Error("Easel web sharing is disabled. Enable it before stopping sharing or deleting a shared Easel."),
                }),
              );
            }

            yield* request(publication, "DELETE");
            yield* save(easelId, null);
            yield* engine.deleteKey(publication.id);
          }),
        );

      return SharingService.of({ start, publish, stop });
    }),
  );
}
