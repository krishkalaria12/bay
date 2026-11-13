// The desktop runtime's layers: the app's infrastructure — the ports a workflow reaches the outside world through —
// and the services that own a workflow. Each authority store builds its own runtime from them (effect/runtime.ts), and
// the coordinator starts the long-lived ones (runtime/services.ts). The session's saving is not one of them: the
// coordinator's owner (lib/persist.ts) is the one writer of a store's documents.
import * as Layer from "effect/Layer";
import { ActivityService, LiveSources } from "../activity/activityService";
import { CalendarEngine, CalendarService } from "../activity/calendarService";
import { ConnectionEngine, ConnectionService } from "../activity/connectionService";
import { LibraryEngine, LibraryService } from "../components/library/libraryService";
import { SharingEngine, SharingService } from "../components/library/sharingService";
import { captureEngineLayer } from "../components/capture/captureEngine";
import { CaptureService } from "../components/capture/service";
import { ExtensionsEngine, ExtensionsService, ExtensionsSearchEngines } from "../components/extensions/service";
import { SettingsEngine, SettingsWorkflows } from "../components/settings/workflows";
import { LittleBayEngine, LittleBayService } from "../components/littleBay/service";
import { MediaEngine, MediaService } from "../components/media/service";
import { PreviewEngine, PreviewService } from "../components/site/previewService";
import { BoostEngine, BoostsService } from "../components/boosts/service";
import { AppIntegrationService, IntegrationEngine } from "../lib/appIntegrationService";
import { Bookmarks, BookmarkEngine } from "../lib/bookmarkService";
import { EngineTabsEngine, EngineTabsService } from "../lib/engineTabs";
import { EnrichmentEngine, EnrichmentService } from "../lib/enrichmentService";
import { History, HistoryEngine } from "../lib/historyService";
import { AutomationEngine, AutomationService, CliEngine } from "../components/cli/automationService";
import { SearchNetwork, SearchService } from "../components/commandBar/searchService";
import { PageWorkEngine, PageWorkService } from "../components/site/pageWorkService";
import { DownloadEngine, DownloadWorkService } from "../lib/downloadWorkService";
import { LocalFileEngine, LocalFileService } from "../lib/localFileService";
import { LifecycleEngine, PageLifecycleService } from "../lib/pageLifecycleService";
import { NotificationEngine, NotificationService } from "../lib/notificationService";
import { ShellEngine, ShellService } from "../lib/shellService";
import { TidyEngine, TidyWorkService } from "../lib/tidyWorkService";
import { UpdaterEngine, UpdaterService } from "../lib/updaterService";
import { Sync } from "../sync/service";
import { DiagnosticsService, TelemetryEngine } from "../telemetry/service";
import { UsageService } from "../telemetry/usageService";
import { ImportEngine, ImportWorkflow } from "../components/import/workflow";
import { ProfileCleanup, ProfileEngine } from "../lib/profileCleanup";
import { Diagnostics } from "./ports/diagnostics";
import { Documents } from "./ports/documents";
import { Http } from "./ports/http";
import { Scheduler } from "./ports/scheduler";

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

const sharing = SharingService.layer.pipe(Layer.provide(Layer.mergeAll(SharingEngine.layer, Http.layer)));

const library = LibraryService.layer.pipe(Layer.provide(LibraryEngine.layer));

const capture = CaptureService.layer.pipe(Layer.provide(Layer.mergeAll(captureEngineLayer, library)));

const littleBay = LittleBayService.layer.pipe(Layer.provide(Layer.mergeAll(LittleBayEngine.layer, Scheduler.layer)));

const integration = AppIntegrationService.layer.pipe(Layer.provide(IntegrationEngine.layer));

const lifecycle = PageLifecycleService.layer.pipe(Layer.provide(Layer.mergeAll(LifecycleEngine.layer, Scheduler.layer)));

const settings = SettingsWorkflows.layer.pipe(Layer.provide(SettingsEngine.layer));

const media = MediaService.layer.pipe(Layer.provide(MediaEngine.layer));

const pageWork = PageWorkService.layer.pipe(Layer.provide(PageWorkEngine.layer));

const search = SearchService.layer.pipe(Layer.provide(SearchNetwork.layer));

const shell = ShellService.layer.pipe(Layer.provide(Layer.mergeAll(ShellEngine.layer, Scheduler.layer)));

const tidy = TidyWorkService.layer.pipe(Layer.provide(TidyEngine.layer));

const enrichment = EnrichmentService.layer.pipe(Layer.provide(EnrichmentEngine.layer));

const engineTabs = EngineTabsService.layer.pipe(Layer.provide(EngineTabsEngine.layer));

const extensions = ExtensionsService.layer.pipe(Layer.provide(ExtensionsEngine.layer), Layer.provide(ExtensionsSearchEngines.layer));

const updater = UpdaterService.layer.pipe(Layer.provide(UpdaterEngine.layer));

const telemetry = DiagnosticsService.layer.pipe(Layer.provide(Layer.mergeAll(TelemetryEngine.layer, Scheduler.layer)));

const usage = UsageService.layer.pipe(Layer.provide(Scheduler.layer));

const boosts = BoostsService.layer.pipe(Layer.provide(Layer.mergeAll(BoostEngine.layer, Documents.layer)));

const connections = ConnectionService.layer.pipe(Layer.provide(ConnectionEngine.layer));

/** The app's services, ready to be built. */
export const appLayer = Layer.mergeAll(
  diagnostics,
  Documents.layer,
  Http.layer,
  Scheduler.layer,
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
  connections,
  capture,
  integration,
  littleBay,
  media,
  lifecycle,
  pageWork,
  search,
  settings,
  telemetry,
  calendar,
  automation,
  preview,
  sharing,
  library,
  extensions,
  shell,
  tidy,
  updater,
  usage,
  enrichment,
  engineTabs,
).pipe(Layer.provide(diagnostics));
