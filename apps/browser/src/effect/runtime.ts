// The desktop runtime: one per JavaScript application instance, shared by every window. Its layers are the app's
// infrastructure — the ports a workflow reaches the outside world through — and the services that own a workflow.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { Persistence } from "../lib/persistenceService";
import { captureException } from "../telemetry/errors";
import { Diagnostics } from "./ports/diagnostics";
import { Documents } from "./ports/documents";
import { Http } from "./ports/http";
import { Scheduler } from "./ports/scheduler";

/** The services every desktop workflow can rely on. */
export type AppServices = Diagnostics | Documents | Http | Persistence | Scheduler;

// One memo map, so a service that two layers need is one instance and not two.
const memoMap = Layer.makeMemoMapUnsafe();

const diagnostics = Diagnostics.layer;

/** The app's services, ready to be built. */
export const appLayer = Layer.mergeAll(diagnostics, Documents.layer, Http.layer, Scheduler.layer, Persistence.layer).pipe(Layer.provide(diagnostics));

/**
 * The app's runtime. It is built on first use and kept for the life of the JavaScript instance, so every window
 * shares one set of services.
 */
export const desktopRuntime = ManagedRuntime.make(appLayer, { memoMap });

/** Resolves once the app's services are built. Background work waits for it before it starts. */
export const desktopReady: Promise<void> = desktopRuntime.context().then(() => undefined);

/**
 * Releases the runtime's resources. This is for a confirmed teardown or a test restart, not for the cancelable
 * quit request: the app keeps running while the user decides.
 */
export const disposeDesktopRuntime = () => desktopRuntime.dispose();

/** Runs a program on the app's runtime. */
export const runDesktop = <A, E>(program: Effect.Effect<A, E, AppServices>): Promise<A> => desktopRuntime.runPromise(program);

/**
 * Starts the services that outlive the bootstrap. The app's own synchronous start stays in main.tsx: this only
 * takes over the work that can wait for the runtime to be ready.
 *
 * A runtime that cannot be built is a failure the user never sees, but the app still has to run: it is reported
 * once, where every other failure goes.
 */
export const startAppServices = (): Promise<void> =>
  desktopRuntime
    .runPromise(
      Effect.gen(function* () {
        const persistence = yield* Persistence;

        yield* persistence.start;
      }),
    )
    .catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));

      captureException(error, "console");
      console.error("The app's services could not start", error);
    });
