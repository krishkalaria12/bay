// Each window owns only work that needs its views. Shared mutations go through the coordinator client.
import { cancelShortcutRecording, recordShortcut } from "@bay/desktop";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { CaptureService } from "../components/capture/service";
import { captureEngineLayer } from "../components/capture/captureEngine";
import { SearchNetwork, SearchService } from "../components/commandBar/searchService";
import { LibraryService } from "../components/library/libraryService";
import { MediaEngine, MediaService } from "../components/media/service";
import { SettingsFailure, SettingsWorkflows, makeShortcutRecorder, usePasswordUnlocks } from "../components/settings/workflows";
import { PASSWORDS_UNLOCK_MS } from "../components/settings/constants";
import { PageWorkEngine, PageWorkService } from "../components/site/pageWorkService";
import { PreviewEngine, PreviewService } from "../components/site/previewService";
import { hasServiceClient, requestService } from "../runtime/serviceClient";
import { browserRead } from "../store/read";
import { NotificationEngine, NotificationService } from "../lib/notificationService";
import { LifecycleEngine, PageLifecycleService } from "../lib/pageLifecycleService";
import { AppIntegrationService, IntegrationEngine } from "../lib/appIntegrationService";
import { ImportEngine, ImportWorkflow } from "../components/import/workflow";
import { ExtensionsEngine, ExtensionsService, ExtensionsSearchEngines } from "../components/extensions/service";
import { EnrichmentEngine, EnrichmentService, defaultEnrichmentRequests } from "../lib/enrichmentService";
import { engineProfileFor } from "../store/model";
import { Diagnostics } from "./ports/diagnostics";
import { Http } from "./ports/http";
import { Scheduler } from "./ports/scheduler";
import { runDesktop } from "./runtime";
import { ReadBrowser, type WindowReadSource } from "./windowPorts";

export type WindowServices =
  | CaptureService
  | SearchService
  | MediaService
  | SettingsWorkflows
  | PageWorkService
  | PreviewService
  | NotificationService
  | PageLifecycleService
  | AppIntegrationService
  | ImportWorkflow
  | ExtensionsService
  | EnrichmentService;

const settingsClient = Layer.effect(
  SettingsWorkflows,
  Effect.gen(function* () {
    const diagnostics = yield* Diagnostics;
    const source = yield* ReadBrowser;

    const report = (failure: SettingsFailure) =>
      diagnostics.report({ operation: failure.operation, message: `${failure.operation.name} failed`, cause: new Error(`${failure.operation.name} failed`) });

    const recording = yield* makeShortcutRecorder(
      {
        recordShortcut: () =>
          Effect.tryPromise({
            try: () => recordShortcut(),
            catch: (cause) => new SettingsFailure({ operation: { name: "shortcut.record" }, cause }),
          }),
        stopRecording: () => Effect.promise(() => cancelShortcutRecording()),
      },
      report,
    );

    const spaceForProfile = (profile: string): string => {
      const state = source.getState();
      const space = state.spaceOrder.find((id) => engineProfileFor(id, state.spaces) === profile);

      if (!space) throw new Error("The password profile is unavailable in this window");

      return space;
    };

    return SettingsWorkflows.of({
      isUnlocked: (profile) => Date.now() < (usePasswordUnlocks.getState()[profile] ?? 0),
      unlock: (profile) =>
        Effect.promise(async () => {
          const unlocked = await requestService<boolean>("settingsUnlock", [spaceForProfile(profile)]);

          if (unlocked) usePasswordUnlocks.setState({ [profile]: Date.now() + PASSWORDS_UNLOCK_MS });

          return unlocked;
        }),
      passwords: (profile) => Effect.promise(() => requestService("settingsPasswords", [spaceForProfile(profile)])),
      importCsv: (profile) => Effect.promise(() => requestService("settingsImportCsv", [spaceForProfile(profile)])),
      exportCsv: (profile) => Effect.promise(() => requestService("settingsExportCsv", [spaceForProfile(profile)])),
      clearData: (spaceId, request) => Effect.promise(() => requestService("settingsClearData", [spaceId, request])),
      record: recording.record,
      stopRecording: recording.stopRecording,
    });
  }),
);

const diagnostics = Diagnostics.layer;
const media = MediaService.layer.pipe(Layer.provide(MediaEngine.layer));
const search = SearchService.layer.pipe(Layer.provide(SearchNetwork.layer));
const preview = PreviewService.layer.pipe(Layer.provide(Layer.mergeAll(PreviewEngine.layer, Http.layer)));
const pageWork = PageWorkService.layer.pipe(Layer.provide(PageWorkEngine.layer));
const notifications = NotificationService.layer.pipe(Layer.provide(NotificationEngine.layer));
const lifecycle = PageLifecycleService.layer.pipe(Layer.provide(Layer.mergeAll(LifecycleEngine.layer, Scheduler.layer)));
const integration = AppIntegrationService.layer.pipe(Layer.provide(IntegrationEngine.layer));
const importWorkflow = ImportWorkflow.layer.pipe(Layer.provide(ImportEngine.layer));

const extensions = ExtensionsService.layer.pipe(
  Layer.provide(ExtensionsEngine.layer),
  Layer.provide(Layer.succeed(ExtensionsSearchEngines)({ apply: () => {} })),
);

const enrichment = defaultEnrichmentRequests.layer.pipe(Layer.provide(EnrichmentEngine.layer));

export function makeWindowRuntime(source: WindowReadSource, windowId: string) {
  const capture = CaptureService.layer.pipe(Layer.provide(Layer.mergeAll(captureEngineLayer, LibraryService.remoteLayer(windowId))));

  return ManagedRuntime.make(
    Layer.mergeAll(
      media,
      search,
      preview,
      pageWork,
      capture,
      settingsClient,
      notifications,
      lifecycle,
      integration,
      importWorkflow,
      extensions,
      enrichment,
    ).pipe(Layer.provide(ReadBrowser.layer(source)), Layer.provide(diagnostics)),
    { memoMap: Layer.makeMemoMapUnsafe() },
  );
}

let runtime: ReturnType<typeof makeWindowRuntime> | undefined;
let disposed = false;
let assignedWindow: string | undefined;

/** The authenticated bootstrap supplies the identity before any view workflow starts. */
export function installWindowRuntime(windowId: string): void {
  if (!windowId || disposed) throw new Error("The window runtime is unavailable");

  if (assignedWindow && assignedWindow !== windowId) throw new Error("Another window runtime is already installed");
  assignedWindow = windowId;
}

/** Runs view work in this window's scope; the legacy native host keeps its existing shared owner. */
export function runWindow<A, E>(program: Effect.Effect<A, E, WindowServices>): Promise<A> {
  if (!hasServiceClient()) return runDesktop(program);

  if (disposed) return Promise.reject(new Error("The window runtime is disposed"));

  if (!assignedWindow) return Promise.reject(new Error("The window runtime has no assigned identity"));
  runtime ??= makeWindowRuntime(browserRead, assignedWindow);

  return runtime.runPromise(program);
}

/** Stops view jobs before the window disconnects from the coordinator. */
export function disposeWindowRuntime(): Promise<void> {
  disposed = true;

  return runtime?.dispose() ?? Promise.resolve();
}
