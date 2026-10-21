// The app itself, which index.js loads once the native build matches this bundle (nativeApi.tsx).
// First, so every native module listener the app adds applies held page reports before it runs.
import "./lib/nativeEvents";
import { batchedUpdates } from "@bay/platform";
import { quietLaunchTabs } from "./components/BlankTabSurface";
import { registerWindowApplication } from "./windowEntry";
import { startTranslate } from "./components/site/translate";
import { startAppIntegration } from "./lib/appIntegration";
import { startNativeSync } from "./lib/native";
import { startCoordinatorServices } from "./runtime/services";
import { perfMark, perfProbeEnabled, probeStore } from "./lib/perfProbe";
import { startTabLifecycle } from "./lib/tabLifecycle";
import { startTabPages } from "./lib/tabPages";
import { startSync } from "./sync/engine";
import { setStoreBatching, useBrowser } from "./store/browser";
import { installErrorReporting, startTelemetry } from "./telemetry";
import { markFirstWindow } from "./telemetry/track";

probeStore("browser", useBrowser);
// Reports stay silent until the user shares them.
installErrorReporting();
setStoreBatching(batchedUpdates);
const backgroundServices = startCoordinatorServices({ store: useBrowser, restoreSession: true });
// Before the native sync: a moved tab's page is handed off before the window it left closes (lib/tabPages.ts).
startTabPages();
startNativeSync({ persistence: backgroundServices });
// After the first window is made: the tab each window starts on doesn't open the command bar.
quietLaunchTabs();
startAppIntegration();
startTabLifecycle();
startTranslate();
startSync(useBrowser);
startTelemetry();
if (__DEV__ || perfProbeEnabled) require("./lib/devHarness").startDevHarness();

registerWindowApplication({ onFirstMount: markFirstWindow });
perfMark("bundleEnd");
