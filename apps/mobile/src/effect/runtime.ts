// The mobile runtime: one per JavaScript instance, shared by every screen. Its layers are the app's infrastructure —
// the ports a service reaches the outside world through — and the services that own a workflow.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import { recordCrash } from "../crashReports.ts";
import { LocaleService } from "../i18n/service.ts";
import { Persistence } from "../store/persistence.ts";
import { Blocker } from "../privacy/blocker.ts";
import { BrowserState } from "./ports/browserState.ts";
import { Diagnostics } from "./ports/diagnostics.ts";
import { Engine } from "./ports/engine.ts";
import { Files } from "./ports/files.ts";
import { Http } from "./ports/http.ts";
import { Lifecycle } from "./ports/lifecycle.ts";
import { Links } from "./ports/links.ts";
import { SecureStore } from "./ports/secureStore.ts";

/** The services every mobile workflow can rely on. */
export type AppServices = Files | Http | SecureStore | Engine | Lifecycle | Links | BrowserState | Diagnostics;

// One memo map, so a service that two layers need is one instance and not two.
const memoMap = Layer.makeMemoMapUnsafe();

const diagnostics = Diagnostics.layer;

// The links port reads the engine's share listener, so it needs the engine to be there.
const links = Links.layer.pipe(Layer.provide(Engine.layer));

// The browsing state and the saved language on disk, kept through the ports they share with everything else.
const persistence = Persistence.layer.pipe(Layer.provide(Layer.mergeAll(Files.layer, BrowserState.layer, Engine.layer, Lifecycle.layer, diagnostics)));
const locale = LocaleService.layer.pipe(Layer.provide(Layer.mergeAll(Files.layer, Lifecycle.layer, diagnostics)));
// The content blocker follows the preferences and keeps the filter lists on disk fresh.
const blocker = Blocker.layer.pipe(Layer.provide(Layer.mergeAll(Files.layer, Http.layer, Engine.layer, BrowserState.layer)));

/** The app's services, ready to be built. */
export const appLayer = Layer.mergeAll(
  diagnostics,
  Files.layer,
  Http.layer,
  SecureStore.layer,
  Engine.layer,
  Lifecycle.layer,
  links,
  BrowserState.layer,
  persistence,
  locale,
  blocker,
).pipe(Layer.provide(diagnostics));

/** The key the runtime keeps itself under, so a reloaded module can find the one it replaces. */
const RUNTIME_KEY = "__bayMobileEffectRuntime__";

/** What a module leaves behind for the next one to dispose. */
type RuntimeHandle = {
  readonly dispose: () => Promise<void>;
};

type RuntimeHost = typeof globalThis & {
  [RUNTIME_KEY]?: RuntimeHandle;
};

// SAFETY: the host is the global object and the key is this module's own, so the handle found there is the one a
// previous copy of this module left behind.
const host = globalThis as RuntimeHost;
const previous = host[RUNTIME_KEY];

host[RUNTIME_KEY] = undefined;

/**
 * The app's runtime. It is built on first use and kept for the life of the JavaScript instance, so every screen
 * shares one set of services.
 */
export const mobileRuntime = ManagedRuntime.make(appLayer, { memoMap });

/**
 * The scope the app's own work lives in: the app state listener, the incoming links, the store subscriptions. It is
 * never closed by backgrounding the app, and it closes when the runtime is disposed.
 */
export const appScope: Scope.Closeable = mobileRuntime.scope;

/**
 * The old runtime's listeners have to go before the new ones arrive, or development would run two sets of them at
 * once. The new runtime waits for this before it builds.
 */
const pendingDisposal = previous ? previous.dispose().catch(() => undefined) : Promise.resolve();

host[RUNTIME_KEY] = { dispose: () => mobileRuntime.dispose() };

/** Resolves once the app's services are built. Background work waits for it before it starts. */
export const mobileReady: Promise<void> = pendingDisposal.then(() => mobileRuntime.context()).then(() => undefined);

/** Runs a program on the app's runtime. */
export const runMobile = <A, E>(program: Effect.Effect<A, E, AppServices>): Promise<A> => pendingDisposal.then(() => mobileRuntime.runPromise(program));

/**
 * Releases the runtime's resources. This is for a confirmed teardown or a test restart: leaving the foreground never
 * disposes it.
 */
export const disposeMobileRuntime = (): Promise<void> => mobileRuntime.dispose();

/**
 * Starts the services that outlive the bootstrap: the browsing state and the saved language, which follow the app's
 * state, the content blocker, and the links that reach Bay from other apps.
 *
 * A service that fails to start is a failure the user never sees, but the app still has to run: it is reported once,
 * where every other failure goes, and the others still start.
 */
const startServices = (): Promise<void> =>
  mobileRuntime
    .runPromise(
      Scope.provide(appScope)(
        Effect.gen(function* () {
          const diagnostics = yield* Diagnostics;
          const links = yield* Links;

          // The listeners are registered on the app scope now; what they do belongs to the services that follow.
          // Each start needs a different service, so the list is typed by what the app layer gives them all.
          const starts: readonly Effect.Effect<void, unknown, Scope.Scope | Layer.Success<typeof appLayer>>[] = [
            Effect.gen(function* () {
              const persistence = yield* Persistence;

              yield* persistence.start();
            }),
            Effect.gen(function* () {
              const locale = yield* LocaleService;

              yield* locale.start();
            }),
            Effect.gen(function* () {
              yield* links.onLink(() => undefined);
            }),
            Effect.gen(function* () {
              yield* links.onShare(() => undefined);
            }),
            Effect.gen(function* () {
              const blocker = yield* Blocker;

              yield* blocker.start;
            }),
          ];

          // Each service owns its startup. One that fails must not hold up the others.
          yield* Effect.forEach(
            starts,
            (start) =>
              start.pipe(
                Effect.catchCauseIf(
                  (cause) => !Cause.hasInterruptsOnly(cause),
                  (cause) =>
                    Effect.gen(function* () {
                      const failure = Cause.squash(cause);
                      const error = failure instanceof Error ? failure : new Error(String(failure));

                      yield* diagnostics.report({ operation: { name: "app.start" }, message: error.message, cause: error });
                    }),
                ),
              ),
            { concurrency: "unbounded", discard: true },
          );
        }),
      ),
    )
    .catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));

      recordCrash(error);
      console.error("The app's services could not start", error);
    });

let started: Promise<void> | undefined;

/** Starts the app's services once per runtime: a layout reloaded in development must not start them a second time. */
export const startAppServices = (): Promise<void> => (started ??= startServices());
