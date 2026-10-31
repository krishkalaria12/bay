import { requireNativeView } from "expo";
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

export interface EngineViewProps extends ViewProps {
  ref?: Ref<Tab>;
  onNavigationStateChange?: (event: NativeSyntheticEvent<NavigationState>) => void;
  /** Main-frame failures only. Native certificate validation is never bypassed. */
  onNavigationError?: (event: NativeSyntheticEvent<NavigationError>) => void;
}

/** Keep mounted while search, start page, or tab chrome overlays it. Navigation uses the ref, not a URL prop. */
export const EngineView = requireNativeView<EngineViewProps>("BayEngine");
