// The desktop runtime: one per JavaScript application instance, shared by every window. Its layers are the app's
// infrastructure — the ports a workflow reaches the outside world through. The services that own a workflow build
// on top of them and are added to the layer as they are migrated.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { Diagnostics } from "./ports/diagnostics";
import { Documents } from "./ports/documents";
import { Http } from "./ports/http";
import { Scheduler } from "./ports/scheduler";

/** The infrastructure every desktop service can rely on. */
export type AppServices = Diagnostics | Documents | Http | Scheduler;

// One memo map, so a service that two layers need is one instance and not two.
const memoMap = Layer.makeMemoMapUnsafe();

const diagnostics = Diagnostics.layer;

/** The app's infrastructure, ready to be built. */
export const appLayer = Layer.mergeAll(diagnostics, Documents.layer, Http.layer, Scheduler.layer).pipe(Layer.provide(diagnostics));

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
