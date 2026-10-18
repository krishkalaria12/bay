// The app itself, which index.js loads once the native build matches this bundle (nativeApi.tsx).
// First, so every native module listener the app adds applies held page reports before it runs.
import "./lib/nativeEvents";
import { batchedUpdates } from "@bay/platform";
import { registerWindowApplication } from "./windowEntry";
import { startTranslate } from "./components/site/translate";
import { startAppIntegration } from "./lib/appIntegration";
import { startNativeSync } from "./lib/native";
import { startPersistence } from "./lib/persist";
import { perfMark, perfProbeEnabled, probeStore } from "./lib/perfProbe";
import { startTabLifecycle } from "./lib/tabLifecycle";
import { startTabPages } from "./lib/tabPages";
import { startSync } from "./sync/engine";
import { startLivePersistence } from "./live/store";
import { setStoreBatching, useBrowser } from "./store/browser";
import { installErrorReporting, startTelemetry } from "./telemetry";
import { markFirstWindow } from "./telemetry/track";

// Live state used to load during imports. Load it before other services or windows.
startLivePersistence();
probeStore("browser", useBrowser);
// Reports stay silent until the user shares them.
installErrorReporting();
setStoreBatching(batchedUpdates);
startPersistence();
// Before the native sync: a moved tab's page is handed off before the window it left closes (lib/tabPages.ts).
startTabPages();
startNativeSync();
startAppIntegration();
startTabLifecycle();
startTranslate();
startSync();
startTelemetry();
if (__DEV__ || perfProbeEnabled) require("./lib/devHarness").startDevHarness();

registerWindowApplication({ onFirstMount: markFirstWindow });
perfMark("bundleEnd");
