import { useRef, type ComponentRef, type JSX } from "react";
import { View } from "react-native";
import { useHideSplash } from "react-native-splash-motion";

import { BrowserScreen } from "@/browser/BrowserScreen";
import { Welcome } from "@/onboarding/Welcome";
import { useBrowserStore } from "@/store/browser";

/** The browser, with the welcome over it on a fresh install until it's finished or skipped. */
export default function Home(): JSX.Element {
  const welcome = useBrowserStore((state) => state.ready && !state.data.preferences.welcomed);
  const ready = useBrowserStore((state) => state.ready);
  const dispatch = useBrowserStore((state) => state.dispatch);
  // The welcome's glass shows the browser underneath it.
  const browser = useRef<ComponentRef<typeof View>>(null);

  // The launch animation goes once Bay's tabs are loaded. A first launch lets the bridge finish building and lifts it
  // away into the welcome; after that Bay is a browser people open in a hurry, so it hands over as soon as it can.
  useHideSplash(ready, welcome ? { outro: "outro", minDuration: 1700 } : { waitForLoop: false, minDuration: 600, fade: 260 });

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
