import { requireNativeModule, requireNativeView } from "expo";
import { Platform } from "react-native";
import type { Ref } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";

/** The currently mounted tab. More tab operations are added as their native implementations land. */
export interface Tab {
  /** Resolves when navigation is requested. Completion and failures arrive through view events. HTTP(S) only. */
  load(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  stop(): Promise<void>;
  /** A JPEG file URI in the app cache, or null before a page has a drawable viewport. */
  snapshot(): Promise<string | null>;
  /**
   * Saves the page's history, scroll position and form text for `stateKey` now. Native saves on its own as pages load
   * and when the app leaves the foreground; this is for a last save just before the view unmounts.
   */
  saveState(): Promise<void>;
  /**
   * Answers a dialog the page asked for (`onPageRequest`): `accepted` is OK vs Cancel, `value` is the prompt's
   * entered text when accepted (empty string for an empty field). An HTTP sign-in uses `username` and `password`
   * instead of `value`. Resolves when the engine delivers the answer.
   */
  answerPageRequest(requestId: string, accepted: boolean, value?: string, username?: string, password?: string): Promise<void>;
  /**
   * Runs a page script (the body of an async function) in the page and resolves with its result as JSON text.
   * iOS runs it in an isolated world the page can't see. Android's system WebView has none, so it runs in the main
   * world behind a token-checked bridge: the token rotates on each main-frame navigation, but a page can still see
   * `__bayPage` and the Symbol.for state keys (it can't guess the token). True isolation waits for our Chromium
   * (A5, phase 7); keep state under a Symbol.for key there. `post(message)` sends a message to `onPageMessage`.
   */
  evaluate(script: string): Promise<string>;
}

export interface NavigationState {
  url: string;
  title: string;
  /** Estimated completion, between 0 and 1. */
  progress: number;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The tab's first navigation became a download, so it has no page to show. */
  blank?: boolean;
}

export interface NavigationError {
  url: string;
  code: string;
  message: string;
}

export interface PageScroll {
  /** Logical screen points. Negative overscroll is clamped to zero. Emitted at most every 50 ms, with a trailing update. */
  offsetY: number;
  deltaY: number;
}

export interface LinkPress {
  url: string;
  /** Anchor text when available; otherwise the URL. */
  title: string;
  /** Normalized coordinates within EngineView. Null when the engine cannot expose the press location. */
  x: number | null;
  y: number | null;
  /**
   * The press is on a bare image, not a link (B13): `url` is the image's own address, so the menu offers opening,
   * copying, sharing and saving the image rather than the link rows.
   */
  image: boolean;
}

export interface EngineViewProps extends ViewProps {
  ref?: Ref<Tab>;
  /** Opened once when the view is created, so a new tab needs no ref call before it is mounted. Later changes are ignored; navigate through the ref. */
  initialUrl?: string;
  /**
   * Restores this tab's last page state (back/forward history, scroll position and form text) before `initialUrl` and
   * saves it as the page changes. Ignored for private tabs, which leave nothing behind. Tab ids are the natural key.
   */
  stateKey?: string;
  /**
   * A private page keeps nothing: it uses a separate data store (iOS) or profile (Android), wiped when the last private
   * tab closes (`setPrivateSessionActive`). Set at creation.
   */
  private?: boolean;
  /** Defaults to true. Hidden tabs pass false so assistive technology skips them. */
  active?: boolean;
  /** Defaults to false. Hidden tabs that aren't playing media pass true so the engine pauses their timers, animations and drawing; snapshots then resolve null. */
  suspended?: boolean;
  /** Defaults to true. Both engines support native back/forward edge gestures: iOS via WebKit, Android via its edge swipe. */
  pullToRefreshEnabled?: boolean;
  /**
   * Desktop site (B12): the page asks its site again with a desktop browser's agent, so the server answers with the desktop layout,
   * rendered shrunk to fit. A private engine still keeps its private store. Changing it reloads the page.
   */
  desktopMode?: boolean;
  onNavigationStateChange?: (event: NativeSyntheticEvent<NavigationState>) => void;
  /** Main-frame failures only. Native certificate validation is never bypassed. */
  onNavigationError?: (event: NativeSyntheticEvent<NavigationError>) => void;
  onScroll?: (event: NativeSyntheticEvent<PageScroll>) => void;
  onLinkPress?: (event: NativeSyntheticEvent<LinkPress>) => void;
  /** A message a page script sent with `post(message)`, as JSON text. */
  onPageMessage?: (event: NativeSyntheticEvent<{ message: string }>) => void;
  /** A site asked a question and waits: `alert`/`confirm`/`prompt`, or the server's HTTP sign-in. Answer with `Tab.answerPageRequest`. */
  onPageRequest?: (event: NativeSyntheticEvent<PageRequest>) => void;
  /** A site's video went fullscreen (Android) or came back out of it. iOS fullscreen is system-presented. */
  onFullscreenChange?: (event: NativeSyntheticEvent<FullscreenChange>) => void;
  /** A new window (`target=_blank`, `window.open`) that becomes a real tab (B19); the opener is the tab that sent it. */
  onNewWindow?: (event: NativeSyntheticEvent<NewWindow>) => void;
}

export interface NewWindow {
  url: string;
  /** In the opener's own browsing session: private stays private, here and in the tab it opens (B19). */
  private: boolean;
}

export interface FullscreenChange {
  fullscreen: boolean;
}

/** A page's `alert`/`confirm`/`prompt` (I3), the server's HTTP sign-in (B3), a link to another app (B5), or a device permission (B7), delivered as a dialog the shared sheet presents. */
export interface PageRequest {
  /** Answer this id back with `Tab.answerPageRequest`. */
  id: string;
  kind: "alert" | "confirm" | "prompt" | "auth" | "external" | "permission";
  message: string;
  /** The prompt's initial text; only present for `prompt`. */
  defaultValue?: string;
  /** The server's realm, shown when it names the protected area; only present for `auth`. */
  realm?: string;
  /** The address that belongs to another app (tel:, mailto:, maps, an app's own scheme); only present for `external`. */
  externalUrl?: string;
  /** Which device the page wants; only present for `permission`. */
  permission?: "camera" | "microphone" | "location" | "camera-microphone";
  /** The page address that asked. */
  url: string;
}

/** Keep mounted while search, start page, or tab chrome overlays it. After `initialUrl`, navigation uses the ref. */
export const EngineView = requireNativeView<EngineViewProps>("BayEngine");

const nativeEngine = requireNativeModule<{
  clearData(): Promise<void>;
  setPrivateSessionActive(active: boolean): Promise<void>;
  pruneSnapshots(keep: string[]): Promise<void>;
  pruneTabStates(keep: string[]): Promise<void>;
  setContentBlocking(listFiles: string[] | null, version: string): Promise<number | null>;
  setBlockingPausedHosts(hosts: string[]): void;
  setTrackingParameters(json: string): boolean;
  privateBrowsingSupported: boolean;
  openDownload(reference: string): Promise<void>;
  cancelDownload(id: string): Promise<void>;
  saveImage(url: string): Promise<void>;
  startListening(): Promise<string | null>;
  addListener(event: "onDownload", listener: (update: DownloadUpdate) => void): { remove(): void };
  addListener(event: "onMediaControl", listener: (event: { action: MediaControl }) => void): { remove(): void };
  addListener(event: "onShare", listener: (event: { url: string }) => void): { remove(): void };
  takeShare(): Promise<string | null>;
  setMediaSession?(title: string | null, site: string, playing: boolean): Promise<void>;
}>("BayEngine");

/** False on Android when the installed WebView can't keep a separate profile; private tabs are unavailable then. */
export const privateBrowsingSupported: boolean = nativeEngine.privateBrowsingSupported;

/**
 * Blocks with filter list files (`file://` URIs, EasyList syntax), or stops blocking with null. The engines read the
 * files off the main thread, so list text never passes through JavaScript. `version` names their contents: iOS
 * compiles WebKit rules once per version and reuses them on later launches. Applies to every page view.
 */
export async function setContentBlocking(listFiles: readonly string[] | null, version: string): Promise<void> {
  await nativeEngine.setContentBlocking(listFiles ? [...listFiles] : null, version);
}

/** Sites (hosts, matching their subdomains) where blocking is paused. */
export function setBlockingPausedHosts(hosts: readonly string[]): void {
  nativeEngine.setBlockingPausedHosts([...hosts]);
}

/** The tracking-parameter table both engines strip from main-frame navigations. */
export interface TrackingParameters {
  global: string[];
  prefixes: string[];
  sites: { hosts: string[]; params: string[]; prefixes: string[] }[];
}

/** The tracking-parameter table (`TRACKING_PARAMS` from `@bay/core`) both engines strip from main-frame navigations. */
export function setTrackingParameters(table: TrackingParameters): boolean {
  return nativeEngine.setTrackingParameters(JSON.stringify(table));
}

/**
 * Whether the app has private tabs, mounted or not. Only a few page views stay live, so private views come and go
 * while their tabs exist: the private session (its cookies and storage) lasts while this is true, and ends once it
 * is false and no private view is left. Call it whenever that changes, and once at launch.
 */
export function setPrivateSessionActive(active: boolean): Promise<void> {
  return nativeEngine.setPrivateSessionActive(active);
}

/** Clear cookies, website storage, network cache and tab snapshots. Close page views first to prevent websites writing new data. */
export function clearData(): Promise<void> {
  return nativeEngine.clearData();
}

/** Deletes tab snapshots that aren't in `keep` (file URIs), except ones written in the last 30 seconds. */
export function pruneSnapshots(keep: readonly string[]): Promise<void> {
  return nativeEngine.pruneSnapshots([...keep]);
}

/** Deletes saved page states whose tab keys aren't in `keep`. */
export function pruneTabStates(keep: readonly string[]): Promise<void> {
  return nativeEngine.pruneTabStates([...keep]);
}

/** Runs a page script on a tab and resolves with its parsed result; rejects after `timeout` ms (a navigation can drop it). */
export function runPageScript<T>(tab: Tab, script: string, timeout = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The page didn't answer.")), timeout);
    tab.evaluate(script).then(
      (json) => {
        clearTimeout(timer);

        try {
          // SAFETY: evaluate resolves the page result as JSON text, so parsing it yields the caller's T by design.
          resolve(JSON.parse(String(json)) as T);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
  });
}

/**
 * A page download's progress. iOS saves to the app's Downloads folder (shown in Files), and on iOS 26 shows the system's
 * progress while Bay is in the background; Android saves to the public one, with a progress notification.
 */
export interface DownloadUpdate {
  id: string;
  url: string;
  filename: string;
  state: "started" | "progress" | "finished" | "failed" | "cancelled";
  /** Bytes so far and in total; total is 0 when the server didn't say. */
  received: number;
  total: number;
  /** The saved file (a file:// URL on iOS, a content:// URI on Android), once finished. */
  path?: string;
  error?: string;
  /** Why a download that hasn't finished isn't moving ("Starting…"; Android also "Waiting for Wi-Fi"); absent while it transfers. */
  waiting?: string;
  /** Started in a private tab: kept out of anything Bay saves. */
  private: boolean;
}

/** Calls `listener` for every download update from any tab, including tabs that have closed since. */
export function addDownloadListener(listener: (update: DownloadUpdate) => void): { remove(): void } {
  return nativeEngine.addListener("onDownload", listener);
}

/** iOS works with a download's file; Android with its saved content:// URI, or the system's download id before Android 10. */
function downloadReference(download: { id: string; path?: string }): string {
  if (Platform.OS === "android") return download.path?.startsWith("content://") && download.id.startsWith("b-") ? download.path : download.id;

  return download.path ?? "";
}

/** Opens a finished download: Quick Look on iOS, the app the system picks on Android. */
export function openDownload(download: { id: string; path?: string }): Promise<void> {
  return nativeEngine.openDownload(downloadReference(download));
}

export function cancelDownload(id: string): Promise<void> {
  return nativeEngine.cancelDownload(id);
}

/** Saves a web image (B13): into the photo library on iOS, through the system downloader on Android. */
export function saveImage(url: string): Promise<void> {
  return nativeEngine.saveImage(url);
}

/**
 * Listens once and resolves with what was said (B16), or null when it wasn't heard / wasn't allowed. On-device
 * where the OS supports it (iOS asks for microphone and speech permission; Android for the record-audio runtime
 * permission), and shows the system's own recogniser UI on both.
 */
export function startListening(): Promise<string | null> {
  return nativeEngine.startListening();
}

/** What the system's media controls asked for. */
export type MediaControl = "toggle" | "stop" | "skip-forward" | "skip-backward";

/**
 * Tells the system what's playing, or null when nothing is. On Android this runs a media playback service with a media
 * notification, so pages keep playing while Bay is in the background; on iOS it posts Now Playing info and remote
 * commands for the lock screen and Control Center, while pages keep playing in the background on their own.
 */
export function setMediaSession(session: { title: string; site: string; playing: boolean } | null): void {
  void nativeEngine.setMediaSession?.(session?.title ?? null, session?.site ?? "", session?.playing ?? false).catch(() => {});
}

/** Calls `listener` when the system media controls ask for play/pause or stop (notification on Android, lock screen on iOS). */
export function addMediaControlListener(listener: (action: MediaControl) => void): { remove(): void } {
  return nativeEngine.addListener("onMediaControl", (event) => listener(event.action));
}

/** Calls `listener` when another app hands Bay a link to share (B14): an Android SEND intent on a running app. */
export function addShareListener(listener: (url: string) => void): { remove(): void } {
  return nativeEngine.addListener("onShare", (event) => listener(event.url));
}

/**
 * A share that launched Bay cold (B14) never fires the running-app event; this reads and takes it once on mount.
 * The iOS share extension opens `bay://share?url=…` instead, which the normal linking pipeline answers.
 */
export function takeShare(): Promise<string | null> {
  return nativeEngine.takeShare();
}
