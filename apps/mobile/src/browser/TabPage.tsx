import { runPageScript, EngineView, type LinkPress, type NavigationState, type PageScroll, type Tab } from "@bay/engine";
import { useEffect, useRef, useState, type JSX } from "react";
import { StyleSheet, View } from "react-native";

import { WATCH_MEDIA_SCRIPT } from "@/pagescripts/media";
import { hideElementsScript } from "@/pagescripts/picker";

import type { BrowserTab } from "@/store/types";

export interface TabPageProps {
  tab: BrowserTab;
  hiddenSelectors: string[];
  onPageMessage: (message: string) => void;
  /** Hidden pages stay mounted, so switching back keeps their scroll position and history. */
  visible: boolean;
  /** Paused in the background (see EngineView `suspended`). */
  suspended: boolean;
  register: (view: Tab | null) => void;
  onNavigation: (state: NavigationState) => void;
  onError: (message: string) => void;
  onScroll: (scroll: PageScroll) => void;
  onLinkPress: (press: LinkPress) => void;
}

export function TabPage({
  tab,
  visible,
  suspended,
  register,
  onNavigation,
  onError,
  onScroll,
  onLinkPress,
  hiddenSelectors,
  onPageMessage,
}: TabPageProps): JSX.Element {
  const view = useRef<Tab>(null);
  // A tab restored from disk or the archive, or opened from a link, starts at its saved address.
  const [initialUrl] = useState(tab.url);

  useEffect(() => {
    const current = view.current;
    if (!current) return;
    register(current);
    return () => register(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The page may be mid-navigation; the next finished load applies the rules again.
  function applyHiddenElements(selectors: string[]): void {
    if (view.current) void runPageScript(view.current, hideElementsScript(selectors)).catch(() => {});
  }

  const selectorsKey = JSON.stringify(hiddenSelectors);
  useEffect(() => {
    applyHiddenElements(JSON.parse(selectorsKey) as string[]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectorsKey]);

  return (
    <View
      testID={visible ? "page-view" : undefined}
      style={[StyleSheet.absoluteFill, { opacity: visible ? 1 : 0 }]}
      pointerEvents={visible ? "auto" : "none"}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
    >
      <EngineView
        ref={view}
        initialUrl={initialUrl || undefined}
        private={tab.private ?? false}
        active={visible}
        suspended={suspended}
        style={{ flex: 1 }}
        onNavigationStateChange={({ nativeEvent }) => {
          onNavigation(nativeEvent);
          if (!view.current) return;
          if (!nativeEvent.isLoading) applyHiddenElements(hiddenSelectors);
          // Media can play before a page finishes loading (a media file streams for as long as it plays), so watching
          // starts once the document is there; it runs once per document.
          if (!nativeEvent.isLoading || nativeEvent.progress > 0.1) void runPageScript(view.current, WATCH_MEDIA_SCRIPT).catch(() => {});
        }}
        onPageMessage={({ nativeEvent }) => onPageMessage(nativeEvent.message)}
        onNavigationError={({ nativeEvent }) => onError(nativeEvent.message)}
        onScroll={({ nativeEvent }) => onScroll(nativeEvent)}
        onLinkPress={({ nativeEvent }) => onLinkPress(nativeEvent)}
      />
    </View>
  );
}
