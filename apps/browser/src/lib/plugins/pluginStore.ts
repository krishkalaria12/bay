import { create } from "zustand";
import type { PluginManifest } from "@bay/chromium";
import type { SettingValue, ToolbarState, ViewItem } from "./protocol";

// What windows show of plugins: the coordinator's (pluginService.ts), mirrored to every window through the service
// state. No secret's value is ever here, only which secrets are set.

export type PluginStatus = "off" | "starting" | "running" | "failed";

export type PluginEntry = { manifest: PluginManifest; enabled: boolean; status: PluginStatus; error: string | null };

export type PluginsState = {
  loaded: boolean;
  plugins: PluginEntry[];
  // Folders in the plugins folder Bay can't run, and why.
  problems: { folder: string; error: string }[];
  // By pluginKey: what a button shows now, and a sidebar view's items.
  toolbar: Record<string, ToolbarState>;
  views: Record<string, ViewItem[]>;
  settings: Record<string, Record<string, SettingValue>>;
  secrets: Record<string, string[]>;
};

export const EMPTY_PLUGINS: PluginsState = { loaded: false, plugins: [], problems: [], toolbar: {}, views: {}, settings: {}, secrets: {} };

export const usePlugins = create<PluginsState>(() => EMPTY_PLUGINS);

/** A plugin's button, view or source, as the state keys it. */
export const pluginKey = (pluginId: string, id: string) => `${pluginId}/${id}`;

/** The plugins whose contributions show: turned on, and not failed. */
export const activePlugins = (s: PluginsState) => s.plugins.filter((p) => p.enabled && p.status !== "failed");

/** A live folder source a plugin adds, as live folders name it. */
export const pluginSourceId = (pluginId: string, sourceId: string) => `plugin:${pluginId}:${sourceId}` as const;

export function parsePluginSourceId(id: string): { pluginId: string; sourceId: string } | null {
  const match = /^plugin:([a-z][a-z0-9-]{1,39}):([A-Za-z][\w-]{0,39})$/.exec(id);

  return match ? { pluginId: match[1]!, sourceId: match[2]! } : null;
}
