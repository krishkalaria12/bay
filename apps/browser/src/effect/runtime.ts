// Runtime access does not acquire services. Only a coordinator or the legacy app entry creates an owner.
import type * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { hasServiceClient } from "../runtime/serviceClient";

import { AuthorityStore } from "./ports/store";
import { ReadBrowser } from "./windowPorts";
import type { BrowserStore } from "../store/browserStore";
import type { ActivityService } from "../activity/activityService";
import type { CalendarService } from "../activity/calendarService";
import type { ConnectionService } from "../activity/connectionService";
import type { LibraryService } from "../components/library/libraryService";
import type { SharingService } from "../components/library/sharingService";

import type { CaptureService } from "../components/capture/service";
import type { ExtensionsService } from "../components/extensions/service";
import type { SettingsWorkflows } from "../components/settings/workflows";
import type { LittleBayService } from "../components/littleBay/service";
import type { MediaService } from "../components/media/service";
import type { PreviewService } from "../components/site/previewService";
import type { BoostsService } from "../components/boosts/service";
import type { AppIntegrationService } from "../lib/appIntegrationService";
import type { Bookmarks } from "../lib/bookmarkService";
import type { EngineTabsService } from "../lib/engineTabs";
import type { EnrichmentService } from "../lib/enrichmentService";
import type { History } from "../lib/historyService";
import type { AutomationService } from "../components/cli/automationService";
import type { SearchService } from "../components/commandBar/searchService";
import type { PageWorkService } from "../components/site/pageWorkService";
import type { DownloadWorkService } from "../lib/downloadWorkService";
import type { LocalFileService } from "../lib/localFileService";
import type { PageLifecycleService } from "../lib/pageLifecycleService";
import type { NotificationService } from "../lib/notificationService";
import type { Persistence } from "../lib/persistenceService";
import type { ShellService } from "../lib/shellService";
import type { TidyWorkService } from "../lib/tidyWorkService";
import type { UpdaterService } from "../lib/updaterService";
import type { Sync } from "../sync/service";
import type { DiagnosticsService } from "../telemetry/service";
import type { UsageService } from "../telemetry/usageService";
import type { ImportWorkflow } from "../components/import/workflow";
import type { ProfileCleanup } from "../lib/profileCleanup";
import type { Diagnostics } from "./ports/diagnostics";
import type { Documents } from "./ports/documents";
import type { Http } from "./ports/http";
import type { Scheduler } from "./ports/scheduler";

/** The services every desktop workflow can rely on. */
export type AppServices =
  | AuthorityStore
  | ReadBrowser
  | ActivityService
  | AppIntegrationService
  | AutomationService
  | Bookmarks
  | BoostsService
  | CalendarService
  | CaptureService
  | ConnectionService
  | Diagnostics
  | DiagnosticsService
  | DownloadWorkService
  | Documents
  | EnrichmentService
  | EngineTabsService
  | ExtensionsService
  | History
  | Http
  | ImportWorkflow
  | LibraryService
  | LittleBayService
  | LocalFileService
  | MediaService
  | NotificationService
  | PageLifecycleService
  | PageWorkService
  | Persistence
  | PreviewService
  | ProfileCleanup
  | Scheduler
  | SearchService
  | SettingsWorkflows
  | SharingService
  | ShellService
  | Sync
  | TidyWorkService
  | UpdaterService
  | UsageService;

export type ApplicationRuntime = {
  context(): Promise<Context.Context<AppServices>>;
  runPromise<A, E>(program: Effect.Effect<A, E, AppServices>): Promise<A>;
  runPromiseExit<A, E>(program: Effect.Effect<A, E, AppServices>): Promise<Exit.Exit<A, E>>;
  dispose(): Promise<void>;
};

export class AuthorityRuntimeDisposed extends Error {
  constructor() {
    super("The authority runtime is disposed");
    this.name = "AuthorityRuntimeDisposed";
  }
}

const stores = new WeakMap<BrowserStore, ApplicationRuntime>();
let installed: ApplicationRuntime | undefined;
let legacy: Promise<ApplicationRuntime> | undefined;

/** A fresh scope and layer memo map for one authority. No services are acquired until its first program. */
export function makeAuthorityRuntime(store: BrowserStore): ApplicationRuntime {
  let pending: Promise<ManagedRuntime.ManagedRuntime<AppServices, never>> | undefined;
  let stopped = false;
  let teardown: Promise<void> | undefined;

  const acquire = () => {
    if (stopped) return Promise.reject(new AuthorityRuntimeDisposed());
    pending ??= import("./runtimeLayer").then(({ appLayer }) =>
      ManagedRuntime.make(appLayer.pipe(Layer.provideMerge(Layer.mergeAll(AuthorityStore.layer(store), ReadBrowser.layer(store)))), {
        memoMap: Layer.makeMemoMapUnsafe(),
      }),
    );

    return pending;
  };

  const runtime: ApplicationRuntime = {
    context: () => acquire().then((owner) => owner.context()),
    runPromise: (program) =>
      acquire().then((owner) => {
        if (stopped) throw new AuthorityRuntimeDisposed();

        return owner.runPromise(program);
      }),
    runPromiseExit: (program) =>
      acquire().then((owner) => {
        if (stopped) throw new AuthorityRuntimeDisposed();

        return owner.runPromiseExit(program);
      }),
    dispose() {
      stopped = true;

      if (installed === runtime) installed = undefined;

      if (stores.get(store) === runtime) stores.delete(store);
      teardown ??= pending ? pending.then((owner) => owner.dispose()) : Promise.resolve();

      return teardown;
    },
  };

  return runtime;
}

/** The same authority gets one runtime until it is disposed. */
export function runtimeForStore(store: BrowserStore): ApplicationRuntime {
  let runtime = stores.get(store);

  if (!runtime) {
    runtime = makeAuthorityRuntime(store);
    stores.set(store, runtime);
  }

  return runtime;
}

/** Binds command wrappers to the coordinator's authority before it starts services. */
export function installAuthorityRuntime(store: BrowserStore): ApplicationRuntime {
  const runtime = runtimeForStore(store);

  if (installed && installed !== runtime) throw new Error("Another authority runtime is already installed");
  installed = runtime;

  return runtime;
}

async function currentRuntime(): Promise<ApplicationRuntime> {
  if (hasServiceClient()) throw new Error("Application services must run in the coordinator");

  if (installed) return installed;
  // The legacy native host and isolated service tests have no window client. Its store is loaded only on use.
  legacy ??= import("../store/browserStore").then(({ useBrowser }) => runtimeForStore(useBrowser));

  return legacy;
}

/** Compatibility facade for legacy commands. Importing it starts no native service or runtime. */
export const desktopRuntime: ApplicationRuntime = {
  context: () => currentRuntime().then((owner) => owner.context()),
  runPromise: (program) => currentRuntime().then((owner) => owner.runPromise(program)),
  runPromiseExit: (program) => currentRuntime().then((owner) => owner.runPromiseExit(program)),
  dispose: async () => {
    const owner = installed ?? (legacy && (await legacy));
    legacy = undefined;
    await owner?.dispose();
  },
};

/** Explicit readiness keeps importing runtime helpers free of service acquisition. */
export const desktopReady = (): Promise<void> => desktopRuntime.context().then(() => undefined);

export const disposeDesktopRuntime = () => desktopRuntime.dispose();
export const runDesktop = <A, E>(program: Effect.Effect<A, E, AppServices>): Promise<A> => desktopRuntime.runPromise(program);
export const runForStore = <A, E>(store: BrowserStore, program: Effect.Effect<A, E, AppServices>): Promise<A> => runtimeForStore(store).runPromise(program);

export const startAppServices = async (): Promise<void> => {
  const owner = await currentRuntime();
  const { startRuntimeServices } = await import("./runtimeLayer");
  await startRuntimeServices(owner);
};
