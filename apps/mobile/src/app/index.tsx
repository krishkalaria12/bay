import { useRef, type ComponentRef, type JSX } from "react";
import { View } from "react-native";

import { BrowserScreen } from "@/browser/BrowserScreen";
import { installCrashReports } from "@/crashReports";
import { Welcome } from "@/onboarding/Welcome";
import { useBrowserStore } from "@/store/browser";

// A crash in a release build says nothing, so Bay keeps what happened (B8). The watch goes on before the first
// screen, so nothing that goes wrong on the way there is lost.
installCrashReports();

/** The browser, with the welcome over it on a fresh install until it's finished or skipped. */
export default function Home(): JSX.Element {
  const welcome = useBrowserStore((state) => state.ready && !state.data.preferences.welcomed);
  const dispatch = useBrowserStore((state) => state.dispatch);
  // The welcome's glass shows the browser underneath it.
  const browser = useRef<ComponentRef<typeof View>>(null);

  return (
    <>
      {/* Out of reach of screen readers while the welcome covers it. */}
      <View
        ref={browser}
        collapsable={false}
        style={{ flex: 1 }}
        accessibilityElementsHidden={welcome}
        importantForAccessibility={welcome ? "no-hide-descendants" : "auto"}
      >
        <BrowserScreen />
      </View>
      {welcome ? <Welcome behind={browser} onDone={() => dispatch({ type: "preferences", update: { welcomed: true } })} /> : null}
    </>
  );
}
