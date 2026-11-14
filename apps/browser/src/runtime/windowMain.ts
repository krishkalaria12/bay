// Imported only after the authenticated mirror and command clients are installed.
import "../lib/bridgeEvents";
import { onCommand } from "@bay/desktop";
import { quietLaunchTabs } from "../components/window/BlankTabSurface";
import { registerWindowApplication } from "../windowEntry";
import { startTranslate } from "../components/site/translateState";
import { startAppIntegration } from "../lib/appMenuIntegration";
import * as Effect from "effect/Effect";
import { runWindow } from "../effect/windowRuntime";
import { PageLifecycleService } from "../lib/pageLifecycleService";
import { startTabPages } from "../lib/tabNavigation";
import { startWindowCloseGuard } from "../lib/windowClose";
import { startExtensionsBridge } from "../components/extensions/bridge";
import { runCommand } from "../lib/appCommands";
import { startWebShortcuts } from "../lib/webShortcuts";
import { installErrorReporting } from "../telemetry";
import { startRequestedOnboarding } from "../components/onboarding/state";
import { startCliActiveTab } from "../components/cli/driverControl";
import { followOnboardingRequests } from "./onboardingRequest";

export function startWindowMain(windowId: string) {
  installErrorReporting();
  quietLaunchTabs();
  onCommand(runCommand);
  startWebShortcuts();
  startWindowCloseGuard();
  // The window is not the coordinator: the extensions' own services and the application lifecycle belong to it.
  startExtensionsBridge({ sharedWindow: true });
  startTabPages();
  void runWindow(Effect.flatMap(PageLifecycleService, (lifecycle) => lifecycle.start)).catch((error) =>
    console.error("The window's page lifecycle could not start", error),
  );
  startTranslate();
  startAppIntegration({ sharedWindow: true });
  registerWindowApplication();
  startCliActiveTab(windowId);
  followOnboardingRequests(windowId, ({ step, picked }) => startRequestedOnboarding(windowId, step, picked));
}
