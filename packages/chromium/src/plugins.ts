import * as v from "valibot";
import { requireOptionalNativeModule, type EventSubscription } from "@bay/platform/native";
import { checked, type JsonValue } from "./json";

// Plugins (apps/browser lib/plugins): folders with a manifest and a script, copied into Bay's plugins folder by
// bay-plugins (packages/rust/bay-plugins), which also checks the manifest. macOS: ios/PluginsModule.swift, where each
// plugin runs in a WebKit page of its own; Windows and Linux: engine webui/plugins.cc, where it runs in a frame of the
// coordinator's document (pluginSandbox.web.ts).

const Text = v.string();

const SettingSchema = v.object({
  key: Text,
  title: Text,
  description: v.optional(Text),
  type: v.picklist(["text", "secret", "toggle", "choice"]),
  default: v.union([Text, v.boolean(), v.null()]),
  options: v.optional(v.array(v.object({ value: Text, title: Text })), []),
});

export const PluginManifestSchema = v.object({
  id: Text,
  name: Text,
  version: Text,
  description: Text,
  author: v.optional(Text),
  main: Text,
  permissions: v.object({ hosts: v.array(Text), tabs: v.boolean(), links: v.boolean() }),
  settings: v.array(SettingSchema),
  contributes: v.object({
    commands: v.array(v.object({ id: Text, title: Text, icon: Text, keywords: v.array(Text), page: v.boolean() })),
    toolbar: v.array(v.object({ id: Text, title: Text, icon: Text, command: v.optional(Text), view: v.optional(Text) })),
    tabMenu: v.array(v.object({ id: Text, title: Text, command: Text })),
    sidebarViews: v.array(v.object({ id: Text, title: Text, icon: Text })),
    liveSources: v.array(v.object({ id: Text, name: Text, kind: v.picklist(["pullRequests", "documents"]), site: v.optional(Text) })),
    themes: v.array(v.object({ id: Text, name: Text, colors: v.array(Text) })),
  }),
});

export type PluginManifest = v.InferOutput<typeof PluginManifestSchema>;

export type PluginSetting = PluginManifest["settings"][number];

const ListSchema = v.object({ plugins: v.array(PluginManifestSchema), problems: v.array(v.object({ folder: Text, error: Text })) });

export type PluginListing = v.InferOutput<typeof ListSchema>;

const InstallSchema = v.variant("ok", [v.object({ ok: v.literal(true), manifest: PluginManifestSchema }), v.object({ ok: v.literal(false), error: Text })]);

export type PluginInstall = v.InferOutput<typeof InstallSchema>;

export type PluginFetchAnswer = { status: number; url: string; headers: Record<string, string>; body: string };

export type PluginSandboxEvent = { id: string; message?: string; reason?: string };

type PluginsNative = {
  list(): Promise<string>;
  // The person picks a plugin folder, which is copied in: bay_plugins_install's JSON, or null when cancelled.
  install(): Promise<string | null>;
  remove(id: string): Promise<boolean>;
  reveal(): Promise<void>;
  // Windows and Linux: bay.fetch through the engine, as a chrome:// document's own fetch meets CORS. macOS's fetch
  // has none.
  fetch?(url: string, method: string, headers: Record<string, string>, body: string | null): Promise<PluginFetchAnswer>;
  // macOS: the sandbox is the host's WebKit page (Windows and Linux frame it in the document).
  start?(id: string): Promise<boolean>;
  stop?(id: string): Promise<void>;
  post?(id: string, message: string): Promise<void>;
  addListener?(name: "onMessage" | "onExit", listener: (event: PluginSandboxEvent) => void): EventSubscription;
};

export const PluginsNative = requireOptionalNativeModule<PluginsNative>("BayPlugins");

export const pluginsAvailable = () => PluginsNative !== null;

function parseJson(text: string): JsonValue {
  try {
    return checked<JsonValue>(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The plugins in Bay's plugins folder, and the folders there that aren't plugins Bay can run. */
export async function listPlugins(): Promise<PluginListing> {
  const text = await PluginsNative?.list();
  const parsed = text ? v.safeParse(ListSchema, parseJson(text)) : null;

  return parsed?.success ? parsed.output : { plugins: [], problems: [] };
}

/** Asks for a plugin folder and copies it in; null when the person cancels. */
export async function installPlugin(): Promise<PluginInstall | null> {
  const text = await PluginsNative?.install();

  if (!text) return null;
  const parsed = v.safeParse(InstallSchema, parseJson(text));

  return parsed.success ? parsed.output : { ok: false, error: "Bay couldn't read the plugin's manifest" };
}

export const removePlugin = (id: string) => PluginsNative?.remove(id) ?? Promise.resolve(false);

export const revealPlugins = () => PluginsNative?.reveal() ?? Promise.resolve();
