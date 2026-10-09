import { appUrlRoute } from "@bay/core";
import { openNewTabPanel } from "../../lib/newTab";
import { setAppUrlOpener } from "../../store/tabs";
import { openSettings, type SettingsPane } from "../settings/windows";

const PANES: Record<string, SettingsPane> = {
  general: "general",
  spaces: "spaces",
  people: "spaces",
  manageprofile: "spaces",
  sync: "sync",
  syncsetup: "sync",
  tabs: "tabs",
  appearance: "appearance",
  privacy: "privacy",
  passwords: "passwords",
  autofill: "autofill",
  addresses: "autofill",
  payments: "autofill",
  extensions: "extensions",
  search: "search",
  searchengines: "search",
  shortcuts: "shortcuts",
  links: "links",
  livefolders: "liveFolders",
  calendar: "calendar",
  advanced: "advanced",
};

export function settingsPaneOf(url: string): SettingsPane | "root" | null {
  const route = appUrlRoute(url);
  if (route?.kind !== "settings") return null;
  return route.section === null ? "root" : (PANES[route.section.toLowerCase()] ?? null);
}

setAppUrlOpener((url, windowId) => {
  const route = appUrlRoute(url);
  if (route?.kind === "newTab") {
    openNewTabPanel(windowId);
    return true;
  }
  const pane = settingsPaneOf(url);
  if (!pane) return false;
  openSettings(pane === "root" ? undefined : pane);
  return true;
});
