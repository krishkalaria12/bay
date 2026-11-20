import * as SplashScreen from "expo-splash-screen";
import { useEffect, type JSX } from "react";
import { View } from "react-native";

import { BrowserScreen } from "@/browser/BrowserScreen";
import { FirstRun } from "@/onboarding/FirstRun";
import { requestField } from "@/onboarding/handoff";
import { useBrowserStore } from "@/store/browser";

/** The browser, with the welcome over it on a fresh install until it's finished or skipped. */
export default function Home(): JSX.Element {
  const welcome = useBrowserStore((state) => state.ready && !state.data.preferences.welcomed);
  const ready = useBrowserStore((state) => state.ready);
  const dispatch = useBrowserStore((state) => state.dispatch);

  // The launch screen goes the moment Bay's tabs are loaded: Bay is a browser people open in a hurry.
  useEffect(() => {
    if (ready) SplashScreen.hide();
  }, [ready]);

  return (
    <>
      {/* Out of reach of screen readers while the welcome covers it. */}
      <View style={{ flex: 1 }} accessibilityElementsHidden={welcome} importantForAccessibility={welcome ? "no-hide-descendants" : "auto"}>
        <BrowserScreen />
      </View>
      {welcome ? (
        <FirstRun
          onDone={(openField) => {
            if (openField) requestField();
            dispatch({ type: "preferences", update: { welcomed: true } });
          }}
        />
      ) : null}
    </>
  );
}
