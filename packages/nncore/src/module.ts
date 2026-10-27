import { Cef, type EngineBoost } from "./native";
import { WebKit, isWebKitDownload, isWebKitPermission, webKitListener } from "./webkit";

export type { EngineBoost, EngineBoostStyle } from "./native";

export type DownloadState = "downloading" | "finished" | "failed" | "cancelled";

export type Download = {
  /** Unique across profiles for the app's lifetime (Chromium numbers downloads per profile). */
  id: string;
  url: string;
  filename: string;
  path: string;
  state: DownloadState;
  paused: boolean;
  received: number;
  total: number;
  speed: number;
  mimeType: string;
  profile?: string;
  /** What the server called the file. When it differs from filename, a person chose the saved name. */
  suggestedFilename?: string;
  /** The page that started the download, when Chromium knows it (blank for a private window's download). */
  referrer?: string;
  tabUrl?: string;
};

export type PermissionKind =
  | "camera"
  | "microphone"
  | "screen"
  | "location"
  | "notifications"
  | "clipboard"
  | "midi"
  | "multipleDownloads"
  | "localFonts"
  | "idleDetection"
  | "storageAccess"
  | "windowManagement"
  | "fileSystem"
  | "keyboardLock"
  | "pointerLock"
  | "protectedMedia"
  | "protocolHandler"
  | "sensors"
  | "localNetwork"
  | "vr"
  | "ar"
  | "handTracking"
  | "identityProvider"
  | "webAppInstallation"
  | "capturedSurfaceControl"
  | "diskQuota"
  | "cameraPanTiltZoom";

export type PermissionRequest = { id: string; browserId: number; origin: string; permissions: PermissionKind[] };
export type PermissionResult = "accept" | "deny" | "dismiss";

export type EngineInfo = {
  pid: number;
  dataDirectory: string;
  engine: string;
  chromiumVersion: string;
  liveBrowsers: number;
  popupWindows: number;
  chromeWindows: number;
};

export type EngineComponent = {
  id: string;
  name: string;
  version: string;
  state:
    | "new"
    | "checking"
    | "canUpdate"
    | "downloading"
    | "decompressing"
    | "patching"
    | "updating"
    | "updated"
    | "upToDate"
    | "updateError"
    | "run"
    | "unknown";
};

export type EngineTask = {
  id: number;
  type:
    | "browser"
    | "gpu"
    | "zygote"
    | "utility"
    | "renderer"
    | "extension"
    | "guest"
    | "plugin"
    | "sandboxHelper"
    | "dedicatedWorker"
    | "sharedWorker"
    | "serviceWorker"
    | "unknown";
  title: string;
  killable: boolean;
  cpu: number;
  processors: number;
  memory: number;
  gpuMemory: number;
  browserIds: number[];
};

export const WIDEVINE_COMPONENT_ID = "oimompecagnajdejgnnjijobebaeigek";

export const engineInfo = () => Cef.engineInfo();

export type ChromeWindowState = {
  profile: string;
  window: number;
  frame: string;
  alpha: number;
  key: boolean;
  canBecomeKey: boolean;
  visible: boolean;
  parentWindow: number;
  chromeWindows: number;
  anchorBrowserId: number;
  anyTabBrowserId: number;
  ready: boolean;
  active: boolean;
  pageInsets: [number, number, number, number];
  hosting: boolean;
  group: string;
  hasRoot: boolean;
  translucent: boolean;
};
export const chromeWindows = () => Cef.chromeWindows();
export const devWindowAction = (windowNumber: number, action: string) => Cef.devWindow(windowNumber, action);
// Whichever engine the tab's page is in keeps it for the tab's next view.
export const prepareTabTransfer = (transferKey: string) => {
  Cef.prepareTransfer(transferKey);
  WebKit?.prepareTransfer(transferKey);
};
export const releaseTabTransfer = (transferKey: string) => {
  Cef.releaseTransfer(transferKey);
  WebKit?.releaseTransfer(transferKey);
};
export const listComponents = () => Cef.components();

export const beginTracing = () => Cef.beginTracing();
export const endTracing = (keep: boolean) => Cef.endTracing(keep);
export const isTracing = () => Cef.isTracing();
export const listTasks = () => Cef.listTasks();
export const killTask = (id: number) => Cef.killTask(id);

export type SystemState = {
  onBattery: boolean;
  batteryLevel: number | null;
  lowPowerMode: boolean;
  memoryPressure: "normal" | "warning" | "critical";
  physicalMemory: number;
};
export const systemState = () => Cef.systemState();
export const onSystemState = (listener: (state: SystemState) => void) => Cef.addListener("onSystemState", listener);

export const setDisplayMediaPicker = (enabled: boolean) => Cef.setDisplayMediaPicker(enabled);
// Chrome's automatic Picture in Picture (a call's own document PiP on a tab switch) follows the app's setting. (Builds
// before it have no such function: Chrome's default, its prompt, stays.)
export const setAutoPictureInPicture = (enabled: boolean) => Cef.setAutoPictureInPicture?.(enabled) ?? Promise.resolve();
// Boosts (Arc's site tweaks), every one that's on: the engine puts their sheets into the pages of their site at document
// start and runs their script in its own isolated world (NNCoreEngine setBoosts:). Builds before it ignore them.
export const setBoosts = (boosts: EngineBoost[]) => Cef.setBoosts?.(boosts) ?? Promise.resolve();
export const setSearchEngineName = (name: string) => Cef.setSearchEngineName(name);
export const getDisplayMediaSources = () => Cef.displayMediaSources();

// Downloads and permission prompts from both engines, in one list; a WebKit one's id says so (webkit.ts).
const bothEngines = <T>(name: "onDownload" | "onPermission" | "onPermissionDismissed", listener: (value: T) => void) => {
  const chromium = Cef.addListener(name as "onDownload", listener as (d: Download) => void);
  const webkit = webKitListener(name, listener);
  return { remove: () => (chromium.remove(), webkit.remove()) };
};
const webKitDownload = (action: "cancel" | "pause" | "resume", id: string) => WebKit?.downloadCommand(action, id) ?? Promise.resolve();

export const onDownload = (listener: (d: Download) => void) => bothEngines("onDownload", listener);
export const cancelDownload = (id: string) => (isWebKitDownload(id) ? webKitDownload("cancel", id) : Cef.cancelDownload(id));
export const pauseDownload = (id: string) => (isWebKitDownload(id) ? webKitDownload("pause", id) : Cef.pauseDownload(id));
export const resumeDownload = (id: string) => (isWebKitDownload(id) ? webKitDownload("resume", id) : Cef.resumeDownload(id));

export const onPermission = (listener: (p: PermissionRequest) => void) => bothEngines("onPermission", listener);
export const onPermissionDismissed = (listener: (p: { id: string }) => void) => bothEngines("onPermissionDismissed", listener);
export const resolvePermission = (id: string, result: PermissionResult, remember = false) =>
  isWebKitPermission(id) ? (WebKit?.resolvePermission(id, result, remember) ?? Promise.resolve()) : Cef.resolvePermission(id, result, remember);

export type BrowsingDataType = "history" | "siteData" | "cache" | "downloads";
export const clearBrowsingData = (profile: string, types: BrowsingDataType[], since?: number) =>
  Promise.all([Cef.clearBrowsingData(profile, types, since ?? null), WebKit?.clearBrowsingData(profile, types, since ?? null).catch(() => {})]).then(() => {});
export const releaseProfile = (profile: string) => Cef.releaseProfile(profile);
// Resolves with the kinds of data that couldn't be deleted (none when it all went).
export const deleteProfileData = async (profile: string): Promise<string[]> => {
  const [chromium, webkit] = await Promise.all([Cef.deleteProfileData(profile), WebKit?.deleteProfileData(profile).catch(() => false) ?? true]);
  return [...(chromium?.remaining ?? ["data"]), ...(webkit ? [] : ["WebKit data"])];
};
