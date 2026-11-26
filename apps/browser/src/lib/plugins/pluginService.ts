import * as v from "valibot";
import type { PluginListing, PluginManifest, PluginSandbox, PluginSandboxEvents } from "@bay/chromium";
import { JsonValueSchema, parseJson, type JsonValue } from "../json";
import {
  checkCall,
  hostAllowed,
  readLinkDecision,
  readLiveItems,
  readSandboxMessage,
  settingValue,
  type FetchInit,
  type LinkDecision,
  type PluginCall,
  type PluginLiveItem,
  type SettingValue,
} from "./protocol";
import { pluginKey, usePlugins, type PluginEntry, type PluginStatus } from "./pluginStore";

// Plugins (G9) in the coordinator: each turned-on plugin's sandbox (@bay/chromium startPluginSandbox), the calls it
// makes (checked by protocol.ts against its manifest) and the handlers Bay runs in it: commands, live sources, a
// sidebar view's items and the links decide hook. Windows reach it through the service commands (pluginActions.ts);
// what they show is usePlugins. What a plugin reaches in Bay is the host's (pluginHost.ts), so tests run it on fakes.

export type FetchAnswer = { status: number; url: string; headers: Record<string, string>; body: string };

export type PluginHost = {
  list(): Promise<PluginListing>;
  remove(id: string): Promise<boolean>;
  sandbox(id: string, events: PluginSandboxEvents): PluginSandbox | null;
  fetch(url: string, init: FetchInit): Promise<FetchAnswer>;
  openTab(url: string, background: boolean): Promise<void>;
  // The page in the front public window.
  activeTab(): { url: string; title: string } | null;
  notify(id: string, title: string, body: string): void;
  // Live folders showing one of the plugin's sources fetch it again.
  refreshLive(sourceId: string): void;
  readDocument(name: string): string | null;
  writeDocument(name: string, text: string): void;
  keychainGet(account: string): Promise<string | null>;
  keychainSet(account: string, secret: string): Promise<void>;
  keychainDelete(account: string): Promise<void>;
  now(): number;
};

const DOC = "plugins.json";
const READY_MS = 10_000;
const RUN_MS = 30_000;
const DECIDE_MS = 400;
const MAX_FETCHES = 8;
const MAX_STORAGE = 1024 * 1024;
const NOTIFY_EVERY_MS = 10_000;

const SavedSchema = v.object({
  enabled: v.optional(v.record(v.string(), v.boolean()), {}),
  settings: v.optional(v.record(v.string(), v.record(v.string(), v.union([v.string(), v.boolean()]))), {}),
  secrets: v.optional(v.record(v.string(), v.array(v.string())), {}),
  storage: v.optional(v.record(v.string(), v.record(v.string(), JsonValueSchema)), {}),
});

type Saved = v.InferOutput<typeof SavedSchema>;

export type RunKind = "command" | "source" | "item" | "links";

/** Where a command was run from, and the page it runs on when the plugin may see it. */
export type CommandContext = { source: "commandBar" | "toolbar" | "tabMenu"; tab: { url: string; title: string } | null };

type Running = {
  manifest: PluginManifest;
  sandbox: PluginSandbox;
  ready: boolean;
  waiting: ((ready: boolean) => void)[];
  runs: Map<number, { resolve(value: JsonValue): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>;
  next: number;
  fetches: number;
  // Runs the person started (a command, an item): bay.tabs.open works only during one.
  personal: number;
  notifiedAt: number;
};

class PluginError extends Error {}

let host: PluginHost | null = null;
let saved: Saved = { enabled: {}, settings: {}, secrets: {}, storage: {} };
const running = new Map<string, Running>();

const secretAccount = (pluginId: string, key: string) => `plugin:${pluginId}:${key}`;

function load(h: PluginHost): Saved {
  const parsed = v.safeParse(SavedSchema, parseJson(h.readDocument(DOC) ?? "null"));

  return parsed.success ? parsed.output : { enabled: {}, settings: {}, secrets: {}, storage: {} };
}

function save() {
  try {
    host?.writeDocument(DOC, JSON.stringify(saved));
  } catch {}
}

function publishSaved() {
  usePlugins.setState({ settings: structuredClone(saved.settings), secrets: structuredClone(saved.secrets) });
}

function setEntry(id: string, patch: Partial<Pick<PluginEntry, "status" | "error">>) {
  usePlugins.setState((s) => ({ plugins: s.plugins.map((p) => (p.manifest.id === id ? { ...p, ...patch } : p)) }));
}

const entry = (id: string) => usePlugins.getState().plugins.find((p) => p.manifest.id === id);

/** A plugin's buttons and views go when it stops. */
function clearShown(id: string) {
  const mine = (key: string) => key.startsWith(`${id}/`);

  usePlugins.setState((s) => ({
    toolbar: Object.fromEntries(Object.entries(s.toolbar).filter(([key]) => !mine(key))),
    views: Object.fromEntries(Object.entries(s.views).filter(([key]) => !mine(key))),
  }));
}

function stopOne(id: string, status: PluginStatus = "off", error: string | null = null) {
  const live = running.get(id);

  if (live) {
    running.delete(id);
    live.sandbox.stop();

    for (const run of live.runs.values()) {
      clearTimeout(run.timer);
      run.reject(new PluginError(error ?? "The plugin stopped"));
    }

    for (const wake of live.waiting) wake(false);
  }

  clearShown(id);
  setEntry(id, { status, error });
}

function startOne(manifest: PluginManifest) {
  const h = host;

  if (!h) return;
  stopOne(manifest.id, "starting");
  let live: Running | null = null;

  const sandbox = h.sandbox(manifest.id, {
    message: (text) => {
      if (live && running.get(manifest.id) === live) void onMessage(live, text);
    },
    exit: (reason) => {
      if (live && running.get(manifest.id) === live) stopOne(manifest.id, "failed", `The plugin's page ${reason}`);
    },
  });

  if (!sandbox) return setEntry(manifest.id, { status: "failed", error: "This Bay can't run plugins" });
  live = { manifest, sandbox, ready: false, waiting: [], runs: new Map(), next: 0, fetches: 0, personal: 0, notifiedAt: 0 };
  running.set(manifest.id, live);
  const started = live;

  setTimeout(() => {
    if (running.get(manifest.id) === started && !started.ready) stopOne(manifest.id, "failed", "The plugin's script didn't load");
  }, READY_MS);
}

const send = (live: Running, message: JsonValue) => live.sandbox.post(JSON.stringify(message));

async function onMessage(live: Running, text: string) {
  const message = readSandboxMessage(text);

  if (!message) return;

  switch (message.t) {
    case "ready":
      if (live.ready) return;
      live.ready = true;
      setEntry(live.manifest.id, { status: "running" });

      for (const wake of live.waiting.splice(0)) wake(true);

      return;
    case "log":
      if (message.level === "error") setEntry(live.manifest.id, { error: message.text.slice(0, 2000) });

      return;
    case "done": {
      const run = live.runs.get(message.n);

      if (!run) return;
      live.runs.delete(message.n);
      clearTimeout(run.timer);

      if (message.ok) run.resolve(message.v ?? null);
      else run.reject(new PluginError(message.e ?? "The plugin failed"));

      return;
    }

    case "call": {
      const checked = checkCall(live.manifest, message.m, message.a);

      if (!checked.ok) return send(live, { t: "reply", n: message.n, ok: false, e: checked.error });

      try {
        const value = await execute(live, checked.call);

        if (running.get(live.manifest.id) === live) send(live, { t: "reply", n: message.n, ok: true, v: value });
      } catch (error) {
        if (running.get(live.manifest.id) === live) send(live, { t: "reply", n: message.n, ok: false, e: error instanceof Error ? error.message : "Failed" });
      }
    }
  }
}

/** A plugin's settings as it reads them: its defaults, what the person set, and its secrets. */
async function settingsOf(manifest: PluginManifest): Promise<Record<string, JsonValue>> {
  const values: Record<string, JsonValue> = {};
  const mine = saved.settings[manifest.id] ?? {};
  const secrets = new Set(saved.secrets[manifest.id] ?? []);

  for (const setting of manifest.settings) {
    if (setting.type === "secret")
      values[setting.key] = secrets.has(setting.key) ? ((await host?.keychainGet(secretAccount(manifest.id, setting.key)).catch(() => null)) ?? null) : null;
    else values[setting.key] = mine[setting.key] ?? setting.default;
  }

  return values;
}

async function execute(live: Running, call: PluginCall): Promise<JsonValue> {
  const h = host;
  const id = live.manifest.id;

  if (!h) throw new PluginError("Plugins aren't running");

  switch (call.method) {
    case "fetch": {
      if (live.fetches >= MAX_FETCHES) throw new PluginError(`At most ${MAX_FETCHES} requests at a time`);
      live.fetches++;

      try {
        const answer = await h.fetch(call.url, call.init);

        // A redirect to a host the manifest doesn't list answers nothing.
        if (!hostAllowed(live.manifest.permissions.hosts, answer.url))
          throw new PluginError(`The request was sent on to ${answer.url.replace(/^([a-z]+:\/\/[^/?#]*).*$/i, "$1")}, which the manifest doesn't list`);

        return answer;
      } finally {
        live.fetches--;
      }
    }

    case "tabs.open":
      if (!live.personal) throw new PluginError("bay.tabs.open works only while a command or item the person chose runs");
      await h.openTab(call.url, call.background);

      return null;
    case "tabs.active":
      return h.activeTab();
    case "settings.get":
      return await settingsOf(live.manifest);
    case "storage.get":
      return saved.storage[id]?.[call.key] ?? null;
    case "storage.set": {
      const next = { ...saved.storage[id] };

      if (call.value === null) delete next[call.key];
      else next[call.key] = call.value;

      if (JSON.stringify(next).length > MAX_STORAGE) throw new PluginError(`A plugin keeps at most ${MAX_STORAGE / 1024 / 1024} MB`);
      saved = { ...saved, storage: { ...saved.storage, [id]: next } };
      save();

      return null;
    }

    case "notify": {
      const now = h.now();

      if (now - live.notifiedAt < NOTIFY_EVERY_MS) throw new PluginError("A plugin notifies at most every 10 seconds");
      live.notifiedAt = now;
      h.notify(`plugin:${id}:${now}`, live.manifest.name, call.message);

      return null;
    }

    case "toolbar.set":
      usePlugins.setState((s) => ({ toolbar: { ...s.toolbar, [pluginKey(id, call.id)]: call.state } }));

      return null;
    case "view.set":
      usePlugins.setState((s) => ({ views: { ...s.views, [pluginKey(id, call.id)]: call.items } }));

      return null;
    case "live.refresh":
      h.refreshLive(`plugin:${id}:${call.id}`);

      return null;
  }
}

function whenReady(live: Running): Promise<boolean> {
  if (live.ready) return Promise.resolve(true);

  return new Promise((resolve) => live.waiting.push(resolve));
}

/** Runs one of a plugin's handlers and answers what it returned. */
export async function runInPlugin(pluginId: string, kind: RunKind, handler: string, args: JsonValue, timeoutMs = RUN_MS, personal = false): Promise<JsonValue> {
  const live = running.get(pluginId);

  if (!live || !(await whenReady(live)) || running.get(pluginId) !== live) throw new PluginError("The plugin isn't running");
  const n = ++live.next;

  if (personal) live.personal++;

  try {
    return await new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        live.runs.delete(n);
        reject(new PluginError(`The plugin didn't answer in ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);

      live.runs.set(n, { resolve, reject, timer });
      send(live, { t: "run", n, k: kind, id: handler, a: args });
    });
  } finally {
    if (personal) live.personal--;
  }
}

// MARK: The coordinator

/** Lists the plugins folder again: new plugins come in off, changed ones restart, removed ones stop. */
export async function reloadPlugins(): Promise<void> {
  const h = host;

  if (!h) return;
  const listing = await h.list();

  if (host !== h) return;
  const before = new Map(usePlugins.getState().plugins.map((p) => [p.manifest.id, p]));
  const ids = new Set(listing.plugins.map((m) => m.id));

  for (const id of running.keys()) if (!ids.has(id)) stopOne(id);

  usePlugins.setState({
    loaded: true,
    problems: listing.problems,
    plugins: listing.plugins.map((manifest) => {
      const was = before.get(manifest.id);
      const enabled = saved.enabled[manifest.id] ?? false;

      return { manifest, enabled, status: was && JSON.stringify(was.manifest) === JSON.stringify(manifest) ? was.status : "off", error: was?.error ?? null };
    }),
  });

  for (const manifest of listing.plugins) {
    const live = running.get(manifest.id);
    const changed = !!live && JSON.stringify(live.manifest) !== JSON.stringify(manifest);

    if (!saved.enabled[manifest.id]) stopOne(manifest.id);
    else if (!live || changed) startOne(manifest);
  }
}

export function startPlugins(h: PluginHost): () => void {
  host = h;
  saved = load(h);
  publishSaved();
  void reloadPlugins().catch(() => usePlugins.setState({ loaded: true }));

  return () => {
    for (const id of running.keys()) stopOne(id);

    if (host === h) host = null;
  };
}

const requireHost = () => {
  if (!host) throw new PluginError("Plugins aren't running");

  return host;
};

const manifestOf = (pluginId: string) => {
  const found = entry(pluginId)?.manifest;

  if (!found) throw new PluginError("No such plugin");

  return found;
};

/** Turns a plugin on (starting it with its current files, even if its manifest didn't change) or off. */
export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  requireHost();
  saved = { ...saved, enabled: { ...saved.enabled, [pluginId]: enabled } };
  save();
  stopOne(pluginId);
  await reloadPlugins();
}

/** Removes a plugin, its files, settings, secrets and storage. */
export async function deletePlugin(pluginId: string): Promise<void> {
  const h = requireHost();
  const manifest = entry(pluginId)?.manifest;

  stopOne(pluginId);

  for (const key of saved.secrets[pluginId] ?? []) await h.keychainDelete(secretAccount(pluginId, key)).catch(() => {});
  const drop = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([id]) => id !== pluginId));
  saved = { enabled: drop(saved.enabled), settings: drop(saved.settings), secrets: drop(saved.secrets), storage: drop(saved.storage) };
  save();
  publishSaved();

  if (manifest) await h.remove(pluginId);
  await reloadPlugins();
}

async function settingsChanged(pluginId: string) {
  publishSaved();
  const live = running.get(pluginId);

  if (live?.ready) send(live, { t: "event", name: "settings", data: await settingsOf(live.manifest) });
}

export async function setPluginSetting(pluginId: string, key: string, value: JsonValue): Promise<void> {
  const setting = manifestOf(pluginId).settings.find((s) => s.key === key);
  const checked = setting ? settingValue(setting, value) : null;

  if (checked === null) throw new PluginError("That isn't a value this setting takes");
  saved = { ...saved, settings: { ...saved.settings, [pluginId]: { ...saved.settings[pluginId], [key]: checked } } };
  save();
  await settingsChanged(pluginId);
}

/** Keeps a secret setting in the system's keychain; null forgets it. */
export async function setPluginSecret(pluginId: string, key: string, secret: string | null): Promise<void> {
  const h = requireHost();

  if (!manifestOf(pluginId).settings.some((s) => s.key === key && s.type === "secret")) throw new PluginError("No such secret");

  if (secret) await h.keychainSet(secretAccount(pluginId, key), secret);
  else await h.keychainDelete(secretAccount(pluginId, key)).catch(() => {});
  const keys = new Set(saved.secrets[pluginId] ?? []);

  if (secret) keys.add(key);
  else keys.delete(key);
  saved = { ...saved, secrets: { ...saved.secrets, [pluginId]: [...keys].sort() } };
  save();
  await settingsChanged(pluginId);
}

/** Runs one of a plugin's commands, from the command bar, the toolbar or the tab menu. */
export async function runPluginCommand(pluginId: string, commandId: string, context: CommandContext): Promise<void> {
  const manifest = manifestOf(pluginId);

  if (!manifest.contributes.commands.some((c) => c.id === commandId)) throw new PluginError("No such command");
  await runInPlugin(pluginId, "command", commandId, { source: context.source, tab: manifest.permissions.tabs ? context.tab : null }, RUN_MS, true);
}

/** The person chose an item of a plugin's sidebar view that has no address of its own. */
export async function selectPluginItem(pluginId: string, viewId: string, itemId: string): Promise<void> {
  if (!usePlugins.getState().views[pluginKey(pluginId, viewId)]?.some((item) => item.id === itemId)) throw new PluginError("No such item");
  await runInPlugin(pluginId, "item", viewId, { item: itemId }, RUN_MS, true);
}

/** A plugin's live source, fetched now. */
export async function pluginSourceItems(pluginId: string, sourceId: string): Promise<PluginLiveItem[]> {
  if (!manifestOf(pluginId).contributes.liveSources.some((s) => s.id === sourceId)) throw new PluginError("No such source");
  const answer = readLiveItems(await runInPlugin(pluginId, "source", sourceId, {}));

  if (!answer.ok) throw new PluginError(answer.error);

  return answer.items;
}

/**
 * Asks the running plugins that decide links where one from another app opens: the first answer, in the plugins'
 * order, that isn't null. Each has a moment to answer; one that's slow or fails leaves the link to Bay's rules.
 */
export async function decideLink(link: { url: string; sourceApp: string | null; spaces: { id: string; name: string }[] }): Promise<LinkDecision | null> {
  const deciders = usePlugins.getState().plugins.filter((p) => p.manifest.permissions.links && running.get(p.manifest.id)?.ready);

  const answers = await Promise.all(
    deciders.map((p) =>
      runInPlugin(p.manifest.id, "links", "links", link, DECIDE_MS).then(
        (value) => readLinkDecision(value),
        () => null,
      ),
    ),
  );

  return answers.find((answer) => answer !== null) ?? null;
}

/** For tests: what the service holds. */
export const pluginsRunning = () => [...running.keys()];

export type { SettingValue };
