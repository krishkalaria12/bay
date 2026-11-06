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
   * Runs a page script (the body of an async function) in the page and resolves with its result as JSON text.
   * iOS runs it in an isolated world the page can't see; Android's system WebView has none, so it runs in the main
   * world: keep state under a Symbol.for key there. `post(message)` sends a message to `onPageMessage`.
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
}

export interface EngineViewProps extends ViewProps {
  ref?: Ref<Tab>;
  /** Opened once when the view is created, so a new tab needs no ref call before it is mounted. Later changes are ignored; navigate through the ref. */
  initialUrl?: string;
  /** A private page keeps nothing: it uses a separate data store (iOS) or profile (Android), wiped when the last private page closes. Set at creation. */
  private?: boolean;
  /** Defaults to true. Hidden tabs pass false so assistive technology skips them. */
  active?: boolean;
  /** Defaults to false. Hidden tabs that aren't playing media pass true so the engine pauses their timers, animations and drawing; snapshots then resolve null. */
  suspended?: boolean;
  /** Defaults to true. iOS also supports the native back/forward edge gestures. */
  pullToRefreshEnabled?: boolean;
  onNavigationStateChange?: (event: NativeSyntheticEvent<NavigationState>) => void;
  /** Main-frame failures only. Native certificate validation is never bypassed. */
  onNavigationError?: (event: NativeSyntheticEvent<NavigationError>) => void;
  onScroll?: (event: NativeSyntheticEvent<PageScroll>) => void;
  onLinkPress?: (event: NativeSyntheticEvent<LinkPress>) => void;
  /** A message a page script sent with `post(message)`, as JSON text. */
  onPageMessage?: (event: NativeSyntheticEvent<{ message: string }>) => void;
}

/** Keep mounted while search, start page, or tab chrome overlays it. After `initialUrl`, navigation uses the ref. */
export const EngineView = requireNativeView<EngineViewProps>("BayEngine");

const nativeEngine = requireNativeModule<{
  clearData(): Promise<void>;
  pruneSnapshots(keep: string[]): Promise<void>;
  setContentBlocking(listFiles: string[] | null, version: string): Promise<number | null>;
  setBlockingPausedHosts(hosts: string[]): void;
  setTrackingParameters(json: string): boolean;
  privateBrowsingSupported: boolean;
  openDownload(reference: string): Promise<void>;
  cancelDownload(id: string): Promise<void>;
  addListener(event: "onDownload", listener: (update: DownloadUpdate) => void): { remove(): void };
  addListener(event: "onMediaControl", listener: (event: { action: MediaControl }) => void): { remove(): void };
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

/** Clear cookies, website storage, network cache and tab snapshots. Close page views first to prevent websites writing new data. */
export function clearData(): Promise<void> {
  return nativeEngine.clearData();
}

/** Deletes tab snapshots that aren't in `keep` (file URIs), except ones written in the last 30 seconds. */
export function pruneSnapshots(keep: readonly string[]): Promise<void> {
  return nativeEngine.pruneSnapshots([...keep]);
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

/** A page download's progress. iOS saves to the app's Downloads folder (shown in Files); Android to the public one. */
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
  /** Started in a private tab: kept out of anything Bay saves. */
  private: boolean;
}

/** Calls `listener` for every download update from any tab, including tabs that have closed since. */
export function addDownloadListener(listener: (update: DownloadUpdate) => void): { remove(): void } {
  return nativeEngine.addListener("onDownload", listener);
}

/** iOS works with a download's file, Android with the system's download id. */
function downloadReference(download: { id: string; path?: string }): string {
  return Platform.OS === "android" ? download.id : (download.path ?? "");
}

/** Opens a finished download: Quick Look on iOS, the app the system picks on Android. */
export function openDownload(download: { id: string; path?: string }): Promise<void> {
  return nativeEngine.openDownload(downloadReference(download));
}

export function cancelDownload(id: string): Promise<void> {
  return nativeEngine.cancelDownload(id);
}

/** What the system's media controls asked for. */
export type MediaControl = "toggle" | "stop";

/**
 * Tells the system what's playing, or null when nothing is. On Android this runs a media playback service with a media
 * notification, so pages keep playing while Bay is in the background; iOS plays in the background on its own.
 */
export function setMediaSession(session: { title: string; site: string; playing: boolean } | null): void {
  void nativeEngine.setMediaSession?.(session?.title ?? null, session?.site ?? "", session?.playing ?? false).catch(() => {});
}

/** Calls `listener` when the media notification's play/pause or stop is pressed (Android). */
export function addMediaControlListener(listener: (action: MediaControl) => void): { remove(): void } {
  return nativeEngine.addListener("onMediaControl", (event) => listener(event.action));
}
