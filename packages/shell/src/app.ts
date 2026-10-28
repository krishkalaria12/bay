import { requireNativeModule, nativeSnapshot, type EventSubscription } from "@bay/platform/native";
import { capabilities } from "@bay/platform";

export type UpdaterState =
  | { available: false; managedBy?: "packageManager" }
  | {
      available: true;
      configured: boolean;
      automaticChecks: boolean;
      automaticDownloads: boolean;
      canCheck: boolean;
      sessionInProgress: boolean;
      feedURL: string | null;
      lastCheck: number | null;
      version: string;
      channel: UpdateChannel;
      pending: PendingUpdate | null;
    };

/** Stable releases, or every nightly too. A nightly's appcast item is on Sparkle's "nightly" channel. */
export type UpdateChannel = "stable" | "nightly";

/** An update waiting for the user: found (Sparkle shows it on install), downloading (nothing to do yet), or
 * downloaded and installing on a restart. */
export type PendingUpdate = { version: string; ready: boolean; downloading?: boolean };

export type AppIcon = { id: string; name: string; preview: string | null };

export type NotificationPermission = "granted" | "denied" | "notDetermined" | "provisional";

export type NotificationOptions = {
  id?: string;
  title: string;
  body?: string;
  subtitle?: string;
  silent?: boolean;
  icon?: string;
  tabId?: string;
  windowId?: string;
  origin?: string;
  dismissible?: boolean;
  data?: Record<string, unknown>;
};

export type NotificationResponse = {
  id: string;
  action: "click" | "close";
  tabId: string | null;
  windowId: string | null;
  data: unknown;
};

export type SystemInfo = {
  appName: string;
  appVersion: string;
  appBuild: string;
  bundleId: string;
  configuration: "Debug" | "Release";
  osVersion: string;
  osBuild: string;
  arch: string;
  model: string;
  memoryGB: number;
  locale: string;
  updates: boolean;
  feedbackURL?: string | null;
  feedbackEmail?: string | null;
  videoTourURL?: string | null;
  releaseNotesURL?: string | null;
  isolatedInstance?: boolean;
  forceReleaseNotes?: boolean;
  processStart?: number | null;
  inApplicationsFolder?: boolean;
};

export type CrashReport = {
  incidentId?: string;
  time: number;
  appVersion?: string;
  build?: string;
  exceptionType?: string;
  signal?: string;
  frames: NativeFrame[];
  /** An uncaught NSException's name (validated natively) and where it was thrown. */
  exceptionName?: string;
  exceptionFrames?: NativeFrame[];
};

type NativeFrame = { image: string; symbol?: string; offset?: number };

export type ScriptState = {
  windows: {
    id: string;
    title: string;
    profileId: string;
    incognito: boolean;
    activeTabId: string | null;
    tabs: { id: string; title: string; url: string; loading: boolean; pinned: boolean }[];
  }[];
  profiles: { id: string; name: string }[];
};

export type ScriptCommand = { id: string } & (
  | { command: "newWindow"; url?: string; incognito: boolean; profileId?: string }
  | { command: "newTab"; windowId?: string; url?: string; index?: number }
  | { command: "setURL"; tabId: string; url: string }
  | { command: "closeTab" | "reload" | "back" | "forward" | "focusTab"; tabId: string }
  | { command: "closeWindow"; windowId: string }
  | { command: "setActiveTabIndex"; windowId: string; index: number }
  | { command: "execute"; tabId: string; code: string }
  | { command: "focusProfile"; profileId: string }
);

type AppModule = {
  readonly apiVersion: number;
  addListener(name: "onNotificationResponse", listener: (e: NotificationResponse) => void): EventSubscription;
  addListener(name: "onScriptCommand", listener: (e: ScriptCommand) => void): EventSubscription;
  addListener(name: "onUpdatePending", listener: (e: { pending: PendingUpdate | null }) => void): EventSubscription;
  updaterState(): Promise<UpdaterState>;
  checkForUpdates(): Promise<void>;
  installPendingUpdate(): Promise<void>;
  disintegrate(windowId: string, rects: [number, number, number, number][]): Promise<void>;
  setAutomaticUpdateChecks(on: boolean): Promise<void>;
  setAutomaticUpdateDownloads(on: boolean): Promise<void>;
  setUpdateChannel(channel: UpdateChannel): Promise<void>;
  setWindowActivity(windowId: string, url: string | null, title: string | null): Promise<void>;
  share(url: string, title: string | null, windowId: string | null): Promise<void>;
  isInDock(): Promise<boolean>;
  addToDock(): Promise<boolean>;
  appIcons(size: number): Promise<AppIcon[]>;
  appIcon(): Promise<string>;
  setAppIcon(id: string): Promise<void>;
  notificationPermission?(): Promise<NotificationPermission>;
  requestNotificationPermission?(): Promise<boolean>;
  postNotification(options: NotificationOptions): Promise<string | null>;
  removeNotifications(ids: string[]): Promise<void>;
  openNotificationSettings?(): Promise<void>;
  setScriptState(state: ScriptState): Promise<void>;
  replyToScript(id: string, result: Record<string, unknown> | null, error: string | null): Promise<void>;
  systemInfo(): SystemInfo;
  openExternalURL(url: string): Promise<boolean>;
  launchEnvironment(name: string): string | null;
  playIntroMusic(cues: IntroMusicCues, muted: boolean): Promise<void>;
  setIntroMusicMuted(muted: boolean): Promise<void>;
  stopIntroMusic(fade: number): Promise<void>;
  devRenderIntroMusic(cues: IntroMusicCues, path: string): Promise<number | null>;
  devRunAppleScript(source: string): Promise<{ ok: boolean; result?: unknown; error?: string; number?: number }>;
  devSnapshotWindow(windowId: string, path: string, transparent?: boolean): Promise<boolean>;
  devMenuCommand(command: string, arg: string | null): Promise<void>;
  devTypeKeys(windowId: string, text: string, interval: number): Promise<KeyTiming[]>;
  devKeyEquivalent(windowId: string, press: KeyPress): Promise<KeyPressResult>;
  crashReports(since: number): Promise<CrashReport[]>;
  devCrash(kind?: "exception"): Promise<void>;
};

const App = requireNativeModule<AppModule>("BayApp");

export const updaterState = () => App.updaterState();
export const checkForUpdates = () => App.checkForUpdates();
export const installPendingUpdate = () => App.installPendingUpdate();

/** The sidebar's Clear: rows (window points from its top-left) break into their own pixels, which blow away. */
export const disintegrate = (windowId: string, rects: { x: number; y: number; width: number; height: number }[]) =>
  App.disintegrate(
    windowId,
    rects.map((r) => [r.x, r.y, r.width, r.height]),
  );
export const onUpdatePending = (listener: (pending: PendingUpdate | null) => void) => App.addListener("onUpdatePending", (e) => listener(e.pending ?? null));
export const setAutomaticUpdateChecks = (on: boolean) => App.setAutomaticUpdateChecks(on);
export const setAutomaticUpdateDownloads = (on: boolean) => App.setAutomaticUpdateDownloads(on);
export const setUpdateChannel = (channel: UpdateChannel) => App.setUpdateChannel(channel);

export const setWindowActivity = (windowId: string, url: string | null, title: string | null) => App.setWindowActivity(windowId, url, title);

export const sharePage = (url: string, title?: string | null, windowId?: string | null) => App.share(url, title ?? null, windowId ?? null);

export const isInDock = () => App.isInDock();
export const addToDock = () => App.addToDock();

export const appIcons = (size = 64) => App.appIcons(size);
export const currentAppIcon = () => App.appIcon();
export const setAppIcon = (id: string) => App.setAppIcon(id);

// Some desktop notification services accept submissions without a permission API.
export const hasNotificationPermissionQuery = () => typeof App.notificationPermission === "function";
export const notificationPermission = () => App.notificationPermission?.() ?? Promise.reject(new Error("Notification permission queries are unavailable"));

export const crashReports = (since: number): Promise<CrashReport[]> => App.crashReports(since);
export const devCrash = (kind?: "exception") => App.devCrash(kind);
export const requestNotificationPermission = () =>
  App.requestNotificationPermission?.() ?? Promise.reject(new Error("Notification permission requests are unavailable"));
export const postNotification = (options: NotificationOptions) => App.postNotification(options);
export const removeNotifications = (ids: string[]) => App.removeNotifications(ids);
export const openNotificationSettings = () => App.openNotificationSettings?.() ?? Promise.reject(new Error("Notification settings are unavailable"));
export const onNotificationResponse = (listener: (e: NotificationResponse) => void) => App.addListener("onNotificationResponse", listener);

export const setScriptState = (state: ScriptState) => App.setScriptState(state);
export const replyToScript = (id: string, result: Record<string, unknown> | null, error: string | null = null) => App.replyToScript(id, result, error);
export const onScriptCommand = (listener: (e: ScriptCommand) => void) => App.addListener("onScriptCommand", listener);

export const systemInfo = () => nativeSnapshot("BayApp", "systemInfo", [], () => App.systemInfo());
export const openExternalURL = (url: string) => App.openExternalURL(url);
export type IntroMusicCues = {
  icon: number;
  letters: number;
  letterStep: number;
  letterCount: number;
  tagline: number;
  exit: number;
  end: number;
};
export const playIntroMusic = (cues: IntroMusicCues, muted: boolean) => {
  if (capabilities.introMusic) void App.playIntroMusic(cues, muted);
};
export const setIntroMusicMuted = (muted: boolean) => {
  if (capabilities.introMusic) void App.setIntroMusicMuted(muted);
};
export const stopIntroMusic = (fade = 0.4) => {
  if (capabilities.introMusic) void App.stopIntroMusic(fade);
};
export const devRenderIntroMusic = (cues: IntroMusicCues, path: string) => App.devRenderIntroMusic(cues, path);
export const launchEnvironment = (name: string) => nativeSnapshot("BayApp", "launchEnvironment", [name], () => App.launchEnvironment(name));
export const devRunAppleScript = (source: string) => App.devRunAppleScript(source);
export const devSnapshotWindow = (windowId: string, path: string, transparent = false) =>
  transparent ? App.devSnapshotWindow(windowId, path, true) : App.devSnapshotWindow(windowId, path);
export type KeyTiming = { due: number; handled: number; drawn: number };
export const devTypeKeys = (windowId: string, text: string, interval: number) => App.devTypeKeys(windowId, text, interval);
export type KeyPress = {
  key: string;
  keyCode: number;
  modifiers?: ("command" | "shift" | "option" | "control" | "function")[];
  characters?: string;
  focus?: "window" | "page" | "devtools";
  asKey?: boolean;
  settle?: number;
  wait?: number;
  dry?: boolean;
};
export type KeyPressResult = {
  handledBy?: "page" | "window" | "menu" | "none";
  firstResponder?: string;
  fired?: { title: string; action: string; command?: string; arg?: string; dry?: boolean }[];
  matched?: { title: string; action: string; command?: string; arg?: string; enabled: boolean }[];
  error?: string;
};
export const devKeyEquivalent = (windowId: string, press: KeyPress): Promise<KeyPressResult> => App.devKeyEquivalent(windowId, press);
export const devMenuCommand = (command: string, arg: string | null = null) => App.devMenuCommand(command, arg);
