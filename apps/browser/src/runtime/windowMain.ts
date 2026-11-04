// Imported only after the authenticated mirror and command clients are installed.
import "../lib/bridgeEvents";
import { onCommand } from "@bay/desktop";
import { quietLaunchTabs } from "../components/window/BlankTabSurface";
import { registerWindowApplication } from "../windowEntry";
import { startTranslate } from "../components/site/translateState";
import { startAppIntegration } from "../lib/appMenuIntegration";
import { startTabLifecycle } from "../lib/tabLifecycle";
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
  startExtensionsBridge({ sharedWindow: true });
  startTabPages();
  startTabLifecycle();
  startTranslate();
  startAppIntegration({ sharedWindow: true });
  registerWindowApplication();
  startCliActiveTab(windowId);
  followOnboardingRequests(windowId, ({ step, picked }) => startRequestedOnboarding(windowId, step, picked));
}
