import { runPageScript, EngineView, type LinkPress, type NavigationError, type NavigationState, type PageScroll, type Tab } from "@bay/engine";
import { useEffect, useRef, useState, type JSX } from "react";
import { StyleSheet, View } from "react-native";

import { WATCH_MEDIA_SCRIPT } from "@/pagescripts/media";
import { hideElementsScript } from "@/pagescripts/picker";
import { PAGE_COLOR_SCRIPT, pageTweaksScript } from "@/pagescripts/tweaks";
import { initialTiming, scriptsFor, shouldHide } from "./navigationEvents";

import type { BrowserTab } from "@/store/types";

export interface TabPageProps {
  tab: BrowserTab;
  hiddenSelectors: string[];
  /** Text size and AMP skipping, applied as each page loads. */
  tweaks: { textSize: number; skipAmp: boolean };
  pullToRefresh: boolean;
  onPageMessage: (message: string) => void;
  /** The colour at the top of the page, [r, g, b], or null when it has none; read as each page loads. */
  onPageColor: (color: [number, number, number] | null) => void;
  /** Hidden pages stay mounted, so switching back keeps their scroll position and history. */
  visible: boolean;
  /** Paused in the background (see EngineView `suspended`). */
  suspended: boolean;
  register: (view: Tab | null) => void;
  onNavigation: (state: NavigationState) => void;
  onError: (error: NavigationError) => void;
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
  tweaks,
  pullToRefresh,
  onPageMessage,
  onPageColor,
}: TabPageProps): JSX.Element {
  const view = useRef<Tab>(null);
  const timing = useRef(initialTiming());
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
    // SAFETY: selectorsKey is the JSON string of hiddenSelectors at this point, so its parse round-trips to a string array.
    const selectors = JSON.parse(selectorsKey) as string[];

    if (shouldHide(timing.current, selectors.length > 0)) applyHiddenElements(selectors);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectorsKey]);

  const tweaksKey = JSON.stringify(tweaks);
  // AMP pages this tab already left for their canonical page. One that comes back (a site sending phones to its AMP
  // copy) stays, so the two never bounce.
  const ampLeft = useRef(new Set<string>());
  const currentUrl = useRef(tab.url);

  function applyTweaks(url = currentUrl.current): void {
    const current = view.current;

    if (!current) return;
    // SAFETY: tweaksKey is the JSON string of tweaks at this point, so its parse round-trips to the settings object.
    const settings = JSON.parse(tweaksKey) as TabPageProps["tweaks"];
    const skipAmp = settings.skipAmp && !ampLeft.current.has(url);
    void runPageScript<string>(current, pageTweaksScript({ ...settings, skipAmp }))
      .then((result) => result === "amp" && ampLeft.current.add(url))
      .catch(() => {});
  }

  // A changed setting applies to the open page at once; the default text size on a fresh tab has nothing to undo.
  const firstTweaks = useRef(true);
  useEffect(() => {
    if (firstTweaks.current) {
      firstTweaks.current = false;

      return;
    }

    applyTweaks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tweaksKey]);

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
        pullToRefreshEnabled={pullToRefresh}
        style={{ flex: 1 }}
        onNavigationStateChange={({ nativeEvent }) => {
          onNavigation(nativeEvent);
          const run = scriptsFor(timing.current, nativeEvent, hiddenSelectors.length > 0);

          if (!view.current) return;

          if (run.hideElements) applyHiddenElements(hiddenSelectors);
          // Early in each load (so text doesn't jump late) and again once it finishes.
          currentUrl.current = nativeEvent.url;

          if (run.watchMedia) {
            applyTweaks(nativeEvent.url);
            void runPageScript<[number, number, number] | null>(view.current, PAGE_COLOR_SCRIPT).then(onPageColor, () => {});
            void runPageScript(view.current, WATCH_MEDIA_SCRIPT).catch(() => {});
          }
        }}
        onPageMessage={({ nativeEvent }) => onPageMessage(nativeEvent.message)}
        onNavigationError={({ nativeEvent }) => onError(nativeEvent)}
        onScroll={({ nativeEvent }) => onScroll(nativeEvent)}
        onLinkPress={({ nativeEvent }) => onLinkPress(nativeEvent)}
      />
    </View>
  );
}
