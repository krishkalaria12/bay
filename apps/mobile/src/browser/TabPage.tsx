import { EngineView, type LinkPress, type NavigationState, type PageScroll, type Tab } from "@bay/engine";
import { useEffect, useRef, useState, type JSX } from "react";
import { StyleSheet, View } from "react-native";

import type { BrowserTab } from "@/store/types";

export interface TabPageProps {
  tab: BrowserTab;
  /** Hidden pages stay mounted, so switching back keeps their scroll position and history. */
  visible: boolean;
  register: (view: Tab | null) => void;
  onNavigation: (state: NavigationState) => void;
  onError: (message: string) => void;
  onScroll: (scroll: PageScroll) => void;
  onLinkPress: (press: LinkPress) => void;
}

export function TabPage({ tab, visible, register, onNavigation, onError, onScroll, onLinkPress }: TabPageProps): JSX.Element {
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
        style={{ flex: 1 }}
        onNavigationStateChange={({ nativeEvent }) => onNavigation(nativeEvent)}
        onNavigationError={({ nativeEvent }) => onError(nativeEvent.message)}
        onScroll={({ nativeEvent }) => onScroll(nativeEvent)}
        onLinkPress={({ nativeEvent }) => onLinkPress(nativeEvent)}
      />
    </View>
  );
}
