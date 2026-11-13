import { onAppEvent } from "@bay/desktop";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { createBrowserPersistence, type PersistenceOwner } from "../lib/persist";
import { AUTO_CLEAN_EVERY_MS } from "../lib/constants";
import { startLive } from "../activity/index";
import { flushLivePersistence, resumeLivePersistence, startLivePersistence } from "../activity/activityStore";
import type { BrowserStore } from "../store/browserStore";
import { installAuthorityRuntime, type ApplicationRuntime } from "../effect/runtime";
import { Bookmarks } from "../lib/bookmarkService";
import { History } from "../lib/historyService";
import { PageLifecycleService } from "../lib/pageLifecycleService";
import { ProfileCleanup } from "../lib/profileCleanup";
import { LibraryService } from "../components/library/libraryService";
import { LittleBayService } from "../components/littleBay/service";
import { UpdaterService } from "../lib/updaterService";
import { UsageService } from "../telemetry/usageService";
import { captureException } from "../telemetry/errors";

export type CoordinatorServices = PersistenceOwner & {
  /** Background startup and finalizers can be awaited by controlled teardown and tests. */
  readonly ready: Promise<void>;
  readonly settled: Promise<void>;
};

const owners = new WeakMap<BrowserStore, CoordinatorServices>();

/** The app's services the authority owns: Chrome's history and bookmarks, the profile cleanup, the Library, Little
 * Bay, the usage the telemetry sends and the updater. They are started from the runtime the authority owns, so there
 * is one of each. The saving is the owner's own (createBrowserPersistence), never the runtime's Persistence service.
 * Page lifecycle watches the pages a document shows: the shared host's windows start their own (runtime/windowMain.ts),
 * so only the single-runtime entry asks for it here.
 */
function startCoordinatorAppServices(runtime: ApplicationRuntime, { pageLifecycle }: { pageLifecycle: boolean }): Promise<void> {
  return runtime
    .runPromise(
      Effect.gen(function* () {
        const history = yield* History;
        const bookmarks = yield* Bookmarks;
        const cleanup = yield* ProfileCleanup;
        const library = yield* LibraryService;
        const littleBay = yield* LittleBayService;
        const usage = yield* UsageService;
        const updater = yield* UpdaterService;
        const starts = [history.start, bookmarks.start, cleanup.start, library.start, littleBay.start, usage.start, updater.start];

        if (pageLifecycle) starts.push((yield* PageLifecycleService).start);

        // Each service owns its startup. A native read that waits or fails must not hold up the others.
        yield* Effect.forEach(
          starts,
          (start) =>
            start.pipe(
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) =>
                  Effect.sync(() => {
                    const failure = Cause.squash(cause);
                    const error = failure instanceof Error ? failure : new Error(String(failure));

                    captureException(error, "console");
                    console.error("An app service could not start", error);
                  }),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        );
      }),
    )
    .catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));

      captureException(error, "console");
      console.error("The coordinator's services could not start", error);
    });
}

/** One background owner per authority. Window entry points never call this.
 * The coordinator supplies an already restored/recovered store; the legacy
 * single-runtime entry restores its disk session here until the startup gate lifts.
 */
export function startCoordinatorServices({
  store,
  restoreSession = false,
  pageLifecycle = false,
  afterLiveRestore,
}: {
  store: BrowserStore;
  restoreSession?: boolean;
  /** The single-runtime entry shows its pages in this document, so it watches their lifecycle too. */
  pageLifecycle?: boolean;
  afterLiveRestore?: () => () => void;
}): CoordinatorServices {
  const existing = owners.get(store);

  if (existing) return existing;
  const runtime = installAuthorityRuntime(store);
  const stops: (() => void)[] = [];
  let disposed = false;
  let teardown: Promise<void> = Promise.resolve();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    owners.delete(store);

    for (const stop of stops.reverse()) {
      try {
        stop();
      } catch (error) {
        console.error("[runtime] background service cleanup failed", error);
      }
    }

    teardown = runtime.dispose();
    // The synchronous invalidation above makes late callbacks inert. The promise records scope finalizers.
    void teardown.catch((error) => console.error("[runtime] scope cleanup failed", error));
  };

  try {
    // Live state must be loaded before the browser and meeting watchers run.
    stops.push(startLivePersistence());

    if (afterLiveRestore) stops.push(afterLiveRestore());

    // The session and the downloads, and the services that watch the documents beside them. The owner reaches
    // the app's own saving service, so there is one writer of each document.
    const persistence = createBrowserPersistence({ store, restoreSession });
    stops.push(() => persistence.dispose());

    // The live folders' engine, the calendar, the meeting groups and the alerts. They are the app's own
    // services, and the runtime the coordinator owns keeps them for as long as the coordinator lives.
    const stopLive = startLive(store);
    stops.push(stopLive);
    const ready = startCoordinatorAppServices(runtime, { pageLifecycle });

    const events = onAppEvent((event) => {
      if (event.type === "resignActive" || event.type === "screenLocked") store.getState().closeAbandonedNewTabs();
    });

    stops.push(() => events.remove());
    const timer = setInterval(() => store.getState().cleanUpInactiveTabs(), AUTO_CLEAN_EVERY_MS);
    stops.push(() => clearInterval(timer));

    const owner: CoordinatorServices = {
      ready,
      get settled() {
        return teardown;
      },
      flush(options?: { final?: boolean }) {
        if (disposed) return Promise.reject(new Error("Background services are disposed"));

        return Promise.all([persistence.flush(options), flushLivePersistence(options)]).then(() => {});
      },
      resume() {
        if (disposed) return;
        persistence.resume();
        resumeLivePersistence();
      },
      dispose,
    };

    owners.set(store, owner);

    return owner;
  } catch (error) {
    dispose();
    throw error;
  }
}
