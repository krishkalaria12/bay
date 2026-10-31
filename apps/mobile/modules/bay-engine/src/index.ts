import { requireNativeModule, requireNativeView } from "expo";
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
  /** Defaults to true. iOS also supports the native back/forward edge gestures. */
  pullToRefreshEnabled?: boolean;
  onNavigationStateChange?: (event: NativeSyntheticEvent<NavigationState>) => void;
  /** Main-frame failures only. Native certificate validation is never bypassed. */
  onNavigationError?: (event: NativeSyntheticEvent<NavigationError>) => void;
  onScroll?: (event: NativeSyntheticEvent<PageScroll>) => void;
  onLinkPress?: (event: NativeSyntheticEvent<LinkPress>) => void;
}

/** Keep mounted while search, start page, or tab chrome overlays it. After `initialUrl`, navigation uses the ref. */
export const EngineView = requireNativeView<EngineViewProps>("BayEngine");

const nativeEngine = requireNativeModule<{ clearData(): Promise<void> }>("BayEngine");

/** Clear cookies, website storage, network cache and tab snapshots. Close page views first to prevent websites writing new data. */
export function clearData(): Promise<void> {
  return nativeEngine.clearData();
}
