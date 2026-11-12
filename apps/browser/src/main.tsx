// The app itself, which index.js loads once the native build matches this bundle (nativeApi.tsx).
// First, so every native module listener the app adds applies held page reports before it runs.
import "./lib/bridgeEvents";
import { useEffect, useState } from "react";
import { AppRegistry, unstable_batchedUpdates } from "react-native";
import { WindowRoot } from "./App";
import { quietLaunchTabs } from "./components/window/BlankTabSurface";
import { DevErrorBoundary } from "./DevErrorBoundary";
import { startTranslate } from "./components/site/translateState";
import { startAppServices } from "./effect/runtime";
import { startAppIntegration } from "./lib/appMenuIntegration";
import { startNativeSync } from "./lib/shellBridge";
import { startPersistence } from "./lib/persistenceService";
import { perfMark, perfProbeEnabled, probeStore } from "./lib/perfProbe";
import { startTabPages } from "./lib/tabNavigation";
import { startSync } from "./sync/engine";
import { setStoreBatching, useBrowser } from "./store/browserStore";
import { installErrorReporting, startTelemetry } from "./telemetry/index";
import { markFirstWindow } from "./telemetry/track";
import { startCliControl } from "./components/cli/driverControl";
import { startUserScripts } from "./components/cli/userScripts";

probeStore("browser", useBrowser);

// Reports stay silent until the user shares them.
installErrorReporting();

setStoreBatching(unstable_batchedUpdates);

startPersistence();

// The runtime takes over the work that outlives the bootstrap: the saving, and later the rest.
void startAppServices();

// Before the native sync: a moved tab's page is handed off before the window it left closes (lib/tabNavigation.ts).
startTabPages();

startNativeSync();

// After the first window is made: the tab each window starts on doesn't open the command bar.
quietLaunchTabs();

startAppIntegration();

startCliControl();

startUserScripts();

startTranslate();

startSync();

startTelemetry();

if (__DEV__ || perfProbeEnabled) require("./lib/devHarness").startDevHarness();

// Development: `globalThis.nnDevMountDelayMs` holds a window's content back that long after its root starts, as a
// window opened under load mounts late (acceptance move-tab-slow-mount).
// SAFETY: globalThis is extensible; the cast only declares the optional nnDevMountDelayMs field the dev harness sets.
const devMountDelay = () => (__DEV__ ? ((globalThis as { nnDevMountDelayMs?: number }).nnDevMountDelayMs ?? 0) : 0);

function Root({ windowId }: { windowId: string }) {
  const [delay] = useState(devMountDelay);
  const [held, setHeld] = useState(delay > 0);
  useEffect(() => {
    if (!held) return;
    const timer = setTimeout(() => setHeld(false), delay);

    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    perfMark("firstWindow");
    markFirstWindow();
  }, []);

  if (held) return null;

  return __DEV__ ? (
    <DevErrorBoundary>
      <WindowRoot windowId={windowId} />
    </DevErrorBoundary>
  ) : (
    <WindowRoot windowId={windowId} />
  );
}

AppRegistry.registerComponent("main", () => Root);

perfMark("bundleEnd");
