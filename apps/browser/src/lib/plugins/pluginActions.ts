import { installPlugin, revealPlugins, type PluginManifest } from "@bay/chromium";
import { confirm } from "@bay/desktop";
import { hasServiceClient, requestService } from "../../runtime/serviceClient";
import { browserRead } from "../../store/read";
import { platformWords } from "../platformWords";
import { commandPage } from "./pluginContext";
import * as service from "./pluginService";
import { usePlugins } from "./pluginStore";

// Plugins from any window: the coordinator's service runs them (pluginService.ts), so a window asks it through the
// service commands; the coordinator's own document calls it directly.

const viaService = <T>(ask: () => Promise<T>, local: () => Promise<T>): Promise<T> => (hasServiceClient() ? ask() : local());

export const reloadPluginList = () => viaService(() => requestService<null>("pluginsReload", []), service.reloadPlugins);

export const enablePlugin = (id: string, on: boolean) =>
  viaService(
    () => requestService<null>("pluginEnable", [id, on]),
    () => service.setPluginEnabled(id, on),
  );

export const deletePluginEverywhere = (id: string) =>
  viaService(
    () => requestService<null>("pluginRemove", [id]),
    () => service.deletePlugin(id),
  );

export const savePluginSetting = (id: string, key: string, value: string | boolean) =>
  viaService(
    () => requestService<null>("pluginSetting", [id, key, value]),
    () => service.setPluginSetting(id, key, value),
  );

export const savePluginSecret = (id: string, key: string, secret: string | null) =>
  viaService(
    () => requestService<null>("pluginSecret", [id, key, secret]),
    () => service.setPluginSecret(id, key, secret),
  );

/** Runs a plugin's command on the window's page, or on `tabId` from the tab menu. */
export const runPluginCommandIn = (
  windowId: string,
  pluginId: string,
  commandId: string,
  from: service.CommandContext["source"],
  tabId: string | null = null,
) =>
  viaService(
    () => requestService<null>("pluginRun", [windowId, pluginId, commandId, from, tabId]),
    () => service.runPluginCommand(pluginId, commandId, { source: from, tab: commandPage(browserRead.getState(), windowId, tabId) }),
  );

export const selectPluginViewItem = (pluginId: string, viewId: string, itemId: string) =>
  viaService(
    () => requestService<null>("pluginSelect", [pluginId, viewId, itemId]),
    () => service.selectPluginItem(pluginId, viewId, itemId),
  );

export const showPluginsFolder = () => revealPlugins();

const hostName = (pattern: string) => pattern.replace(/^https?:\/\//, "");

const count = (n: number, one: string, many = `${one}s`) => (n === 1 ? `a ${one}` : `${n} ${many}`);

/** What a plugin may do and adds, as sentences for the person to agree to. */
export function pluginSummary(manifest: PluginManifest): string[] {
  const { permissions, contributes, settings } = manifest;
  const lines: string[] = [];

  if (permissions.hosts.length) lines.push(`Send requests to ${permissions.hosts.map(hostName).join(", ")}, without your cookies`);

  if (permissions.tabs) lines.push("See the address and title of the page you run its commands on (never a private window's)");

  if (permissions.links) lines.push("Choose where links from other apps open");

  if (settings.some((s) => s.type === "secret")) lines.push(`Keep what you give it in ${platformWords.secretStore}`);

  const adds = [
    contributes.commands.length && count(contributes.commands.length, "command"),
    contributes.toolbar.length && count(contributes.toolbar.length, "toolbar button"),
    contributes.tabMenu.length && count(contributes.tabMenu.length, "tab menu item"),
    contributes.sidebarViews.length && count(contributes.sidebarViews.length, "sidebar view"),
    contributes.liveSources.length && count(contributes.liveSources.length, "live folder source"),
    contributes.themes.length && count(contributes.themes.length, "theme"),
  ].filter((part): part is string => !!part);

  if (adds.length) lines.push(`Add ${adds.join(", ")}`);

  return lines.length ? lines : ["Nothing beyond its own page: it asks for no permissions and adds nothing"];
}

/**
 * Add Plugin…: the person picks a plugin's folder, Bay copies it in and says what it may do, and it's turned on. A new
 * plugin the person doesn't agree to goes again; an update they don't agree to stays, turned off.
 */
export async function addPlugin(windowId?: string): Promise<void> {
  const before = new Set(usePlugins.getState().plugins.map((p) => p.manifest.id));
  const result = await installPlugin();

  if (!result) return;

  if (!result.ok) {
    await confirm({ title: "Bay couldn't add the plugin", message: result.error, confirmTitle: "OK", windowId });

    return;
  }

  const m = result.manifest;
  const lines = pluginSummary(m).map((line) => `• ${line}`);

  const { confirmed } = await confirm({
    title: `Add “${m.name}”?`,
    message: [
      m.description,
      `${m.name} ${m.version}${m.author ? ` by ${m.author}` : ""} runs on its own, apart from your pages and from Bay. It can:`,
      ...lines,
      "Settings › Plugins turns it off or removes it.",
    ]
      .filter(Boolean)
      .join("\n"),
    confirmTitle: before.has(m.id) ? "Update Plugin" : "Add Plugin",
    cancelTitle: "Cancel",
    windowId,
  });

  if (confirmed) await enablePlugin(m.id, true);
  else if (before.has(m.id)) await enablePlugin(m.id, false);
  else await deletePluginEverywhere(m.id);
}
