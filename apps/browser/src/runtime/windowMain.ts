// Imported only after the authenticated mirror and command clients are installed.
import "../lib/nativeEvents";
import { onCommand } from "@bay/shell";
import { quietLaunchTabs } from "../components/BlankTabSurface";
import { registerWindowApplication } from "../windowEntry";
import { startTranslate } from "../components/site/translate";
import { startAppIntegration } from "../lib/appIntegration";
import { startTabLifecycle } from "../lib/tabLifecycle";
import { startTabPages } from "../lib/tabPages";
import { startWindowCloseGuard } from "../lib/windowClose";
import { startExtensionsBridge } from "../components/extensions/bridge";
import { runCommand } from "../lib/commands";
import { startWebShortcuts } from "../lib/webShortcuts";
import { installErrorReporting } from "../telemetry";

export function startWindowMain() {
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
}
