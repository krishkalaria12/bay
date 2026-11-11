// The desktop runtime: one per JavaScript application instance, shared by every window. Its layers are the app's
// infrastructure — the ports a workflow reaches the outside world through — and the services that own a workflow.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { ActivityService, LiveSources } from "../activity/activityService";
import { CalendarEngine, CalendarService } from "../activity/calendarService";
import { LibraryEngine, LibraryService } from "../components/library/libraryService";
import { SharingEngine, SharingService } from "../components/library/sharingService";
import { ExtensionsEngine, ExtensionsService } from "../components/extensions/service";
import { PreviewEngine, PreviewService } from "../components/site/previewService";
import { BoostEngine, BoostsService } from "../components/boosts/service";
import { Bookmarks, BookmarkEngine } from "../lib/bookmarkService";
import { EngineTabsEngine, EngineTabsService } from "../lib/engineTabs";
import { EnrichmentEngine, EnrichmentService } from "../lib/enrichmentService";
import { History, HistoryEngine } from "../lib/historyService";
import { AutomationEngine, AutomationService, CliEngine } from "../components/cli/automationService";
import { SearchNetwork, SearchService } from "../components/commandBar/searchService";
import { DownloadEngine, DownloadWorkService } from "../lib/downloadWorkService";
import { LocalFileEngine, LocalFileService } from "../lib/localFileService";
import { NotificationEngine, NotificationService } from "../lib/notificationService";
import { Persistence } from "../lib/persistenceService";
import { TidyEngine, TidyWorkService } from "../lib/tidyWorkService";
import { ShellEngine, ShellService } from "../lib/shellService";
import { UpdaterEngine, UpdaterService } from "../lib/updaterService";
import { Sync } from "../sync/service";
import { UsageService } from "../telemetry/usageService";
import { ImportEngine, ImportWorkflow } from "../components/import/workflow";
import { ProfileCleanup, ProfileEngine } from "../lib/profileCleanup";
import { captureException } from "../telemetry/errors";
import { Diagnostics } from "./ports/diagnostics";
import { Documents } from "./ports/documents";
import { Http } from "./ports/http";
import { Scheduler } from "./ports/scheduler";

/** The services every desktop workflow can rely on. */
export type AppServices =
  | ActivityService
  | AutomationService
  | Bookmarks
  | BoostsService
  | CalendarService
  | Diagnostics
  | DownloadWorkService
  | Documents
  | EngineTabsService
  | ExtensionsService
  | EnrichmentService
  | History
  | Http
  | ImportWorkflow
  | LibraryService
  | LocalFileService
  | NotificationService
  | Persistence
  | PreviewService
  | SearchService
  | ProfileCleanup
  | Scheduler
  | ShellService
  | SharingService
  | UpdaterService
  | UsageService
  | Sync
  | TidyWorkService;

// One memo map, so a service that two layers need is one instance and not two.
const memoMap = Layer.makeMemoMapUnsafe();

const diagnostics = Diagnostics.layer;

const history = History.layer.pipe(Layer.provide(HistoryEngine.layer));

const bookmarks = Bookmarks.layer.pipe(Layer.provide(BookmarkEngine.layer));

const profileCleanup = ProfileCleanup.layer.pipe(Layer.provide(ProfileEngine.layer));

const sync = Sync.layer;

const importWorkflow = ImportWorkflow.layer.pipe(Layer.provide(ImportEngine.layer));

const activity = ActivityService.layer.pipe(Layer.provide(Layer.mergeAll(Scheduler.layer, LiveSources.layer)));

const notifications = NotificationService.layer.pipe(Layer.provide(NotificationEngine.layer));

const localFiles = LocalFileService.layer.pipe(Layer.provide(LocalFileEngine.layer));

const downloads = DownloadWorkService.layer.pipe(Layer.provide(DownloadEngine.layer));

const calendar = CalendarService.layer.pipe(Layer.provide(Layer.mergeAll(CalendarEngine.layer, Scheduler.layer)));

const automation = AutomationService.layer.pipe(Layer.provide(Layer.mergeAll(AutomationEngine.layer, CliEngine.layer)));

const preview = PreviewService.layer.pipe(Layer.provide(Layer.mergeAll(Http.layer, PreviewEngine.layer)));

const search = SearchService.layer.pipe(Layer.provide(SearchNetwork.layer));

const sharing = SharingService.layer.pipe(Layer.provide(Layer.mergeAll(SharingEngine.layer, Http.layer)));

const library = LibraryService.layer.pipe(Layer.provide(LibraryEngine.layer));

const extensions = ExtensionsService.layer.pipe(Layer.provide(ExtensionsEngine.layer));

const tidy = TidyWorkService.layer.pipe(Layer.provide(TidyEngine.layer));

const engineTabs = EngineTabsService.layer.pipe(Layer.provide(EngineTabsEngine.layer));

const shell = ShellService.layer.pipe(Layer.provide(Layer.mergeAll(ShellEngine.layer, Scheduler.layer)));

const enrichment = EnrichmentService.layer.pipe(Layer.provide(EnrichmentEngine.layer));

const usage = UsageService.layer.pipe(Layer.provide(Scheduler.layer));

const boosts = BoostsService.layer.pipe(Layer.provide(Layer.mergeAll(BoostEngine.layer, Documents.layer)));

const updater = UpdaterService.layer.pipe(Layer.provide(UpdaterEngine.layer));

/** The app's services, ready to be built. */
export const appLayer = Layer.mergeAll(
  diagnostics,
  Documents.layer,
  Http.layer,
  Scheduler.layer,
  Persistence.layer,
  history,
  bookmarks,
  profileCleanup,
  sync,
  importWorkflow,
  activity,
  notifications,
  localFiles,
  downloads,
  boosts,
  search,
  calendar,
  automation,
  preview,
  sharing,
  library,
  extensions,
  tidy,
  engineTabs,
  shell,
  enrichment,
  usage,
  updater,
).pipe(Layer.provide(diagnostics));

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

        const history = yield* History;

        yield* history.start;

        const bookmarks = yield* Bookmarks;

        yield* bookmarks.start;

        const cleanup = yield* ProfileCleanup;

        yield* cleanup.start;

        const library = yield* LibraryService;

        yield* library.start;

        const updater = yield* UpdaterService;

        yield* updater.start;

        const usage = yield* UsageService;

        yield* usage.start;
      }),
    )
    .catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));

      captureException(error, "console");
      console.error("The app's services could not start", error);
    });
