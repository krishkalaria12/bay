import { checkForUpdates, confirm, isDefaultBrowser, setAsDefaultBrowser, systemInfo } from "@bay/shell";
import { sendFeedback } from "../../lib/appIntegration";
import { openReleaseNotesPage, releaseNotesUrl } from "../../lib/releaseNotesPage";
import { startOnboarding } from "../onboarding";
import { openSettings } from "../settings/windows";
import type { PaletteMenuAction } from "./PaletteActionMenu";

// Asked each time the menu opens: "Make … the Default Browser" shows only while Bay isn't.
export async function appPaletteActions(windowId: string, onDismiss: () => void): Promise<PaletteMenuAction[]> {
  const app = systemInfo();
  const isDefault = await isDefaultBrowser().catch(() => false);
  const action = (entry: PaletteMenuAction): PaletteMenuAction => ({
    ...entry,
    run: async () => {
      await entry.run();
      onDismiss();
    },
  });
  const items: PaletteMenuAction[] = [
    { id: "feedback", title: "Send Feedback", icon: "text.bubble", run: () => sendFeedback(windowId) },
    ...(releaseNotesUrl() ? [{ id: "changelog", title: "Changelog", icon: "doc.text", run: () => openReleaseNotesPage(windowId) }] : []),
    { id: "shortcuts", title: "Keyboard Shortcuts", icon: "command", run: () => openSettings("shortcuts") },
    ...(app.updates ? [{ id: "updates", title: "Check for Updates", icon: "clock.arrow.circlepath", separator: true, run: checkForUpdates }] : []),
    ...(isDefault
      ? []
      : [
          {
            id: "default-browser",
            title: `Make ${app.appName} the Default Browser`,
            icon: "globe",
            separator: !app.updates,
            run: async () => {
              if (!(await setAsDefaultBrowser())) throw new Error("The default browser wasn't changed. Try again.");
            },
          },
        ]),
    { id: "setup", title: `Set up ${app.appName}`, icon: "checklist", separator: !app.updates && isDefault, run: () => startOnboarding(windowId) },
    {
      id: "about",
      title: `About ${app.appName}`,
      icon: "info.circle",
      separator: true,
      run: () =>
        confirm({
          title: `About ${app.appName}`,
          message: `${app.appName} ${app.appVersion}\nBuild ${app.appBuild}\nmacOS ${app.osVersion}`,
          confirmTitle: "OK",
          windowId,
        }),
    },
    { id: "settings", title: "Settings", icon: "gearshape", hint: "⌘,", run: () => openSettings() },
  ];
  return items.map(action);
}
