import { installExtension, listExtensions, reloadExtension, uninstallExtension, type InstalledExtension } from "@bay/nncore";
import { onUserScriptsChange, readUserScripts, userScriptsAvailable, watchUserScripts, writeUserScriptsStatus, type UserScriptsFolder } from "@bay/shell";
import { useBrowser, type BrowserState } from "../../store/browser";
import { engineProfile, isIncognitoSpace } from "../../store/model";

export type ScriptsOutcome = { ok: true } | { disabled: true } | { removed: true } | { error: string };
type Status = { generation: number; profiles: Record<string, ScriptsOutcome> };

const enabled = () => useBrowser.getState().settings.cliControl ?? false;

export function scriptsTargets(s: Pick<BrowserState, "spaceOrder" | "spaces">): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  const taken = new Map<string, number>();
  for (const id of s.spaceOrder) {
    const profile = s.spaces[id];
    if (!profile || isIncognitoSpace(id)) continue;
    const base = profile.name.trim() || id;
    const seen = (taken.get(base) ?? 0) + 1;
    taken.set(base, seen);
    const name = seen === 1 ? base : `${base} (${seen})`;
    const engine = engineProfile(id);
    targets.set(engine, [...(targets.get(engine) ?? []), name]);
  }
  return targets;
}

const targetsKey = (targets: Map<string, string[]>) => JSON.stringify([...targets]);

const withoutPrivate = (path: string) => path.replace(/^\/private(?=\/(tmp|var|etc)\/)/, "");
const loadedFrom = (ext: InstalledExtension, path: string) => !!ext.path && withoutPrivate(ext.path) === withoutPrivate(path);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const BLOCKED = "Bay Scripts can only hold content scripts, and the engine blocked this copy.";

async function load(profile: string, path: string): Promise<ScriptsOutcome> {
  try {
    const find = async (match: (x: InstalledExtension) => boolean) => (await listExtensions(profile)).find(match);
    const existing = await find((x) => loadedFrom(x, path));
    if (existing && !existing.enabled && !existing.blockedByPolicy) {
      await reloadExtension(existing.id, profile);
      return { disabled: true };
    }
    const id = await installExtension({ path }, profile);
    const loaded = await find((x) => x.id === id);
    if (!loaded) return { error: "The extension didn't load." };
    if (loaded.enabled) return { ok: true };
    if (loaded.blockedByPolicy) return { error: loaded.errors[0] ?? BLOCKED };
    return loaded.state === "DISABLED" ? { disabled: true } : { error: `The extension is ${loaded.state.toLowerCase()}.` };
  } catch (error) {
    return { error: message(error) };
  }
}

async function unload(profile: string, path: string): Promise<ScriptsOutcome> {
  try {
    for (const ext of (await listExtensions(profile)).filter((x) => loadedFrom(x, path))) await uninstallExtension(ext.id, profile);
    return { removed: true };
  } catch (error) {
    return { error: message(error) };
  }
}

const withError = (unloaded: ScriptsOutcome, refused: string): ScriptsOutcome =>
  "error" in unloaded ? { error: `${refused} (and the loaded copy couldn't be removed: ${unloaded.error})` } : { error: refused };

type Wanted = "present" | "absent";
const applied = new Map<string, { generation: number; wanted: Wanted; outcome: ScriptsOutcome }>();
let lastStatus: string | null = null;
let running: Promise<void> | null = null;
let again = false;

async function reconcile() {
  if (!enabled()) return;
  const folder: UserScriptsFolder = await readUserScripts();
  if (!enabled() || again) return;
  if (folder.state === "empty" || folder.state === "busy" || folder.state === "pending") return;
  const generation = folder.generation ?? 0;
  const targets = scriptsTargets(useBrowser.getState());
  const outcomes = new Map<string, ScriptsOutcome>();
  const refused = folder.state === "invalid" ? folder.error : null;
  const loadPath = folder.state === "ready" ? folder.path : null;
  const unloadPath = folder.state === "absent" || folder.state === "invalid" ? folder.path : null;
  const wanted: Wanted = loadPath ? "present" : "absent";
  for (const engine of targets.keys()) {
    const done = applied.get(engine);
    const cached = refused === null && done?.generation === generation && done.wanted === wanted ? done.outcome : null;
    let outcome: ScriptsOutcome;
    if (cached) outcome = cached;
    else if (refused !== null) outcome = unloadPath ? withError(await unload(engine, unloadPath), refused) : { error: refused };
    else if (loadPath) outcome = await load(engine, loadPath);
    else if (unloadPath) outcome = await unload(engine, unloadPath);
    else outcome = { removed: true };
    if (!cached && (await readUserScripts()).token !== folder.token) {
      applied.delete(engine);
      again = true;
      return;
    }
    outcomes.set(engine, outcome);
    if (!("error" in outcome)) applied.set(engine, { generation, wanted, outcome });
    if (!enabled()) return;
  }
  if (again || !enabled()) return;
  const status: Status = { generation, profiles: Object.create(null) as Record<string, ScriptsOutcome> };
  for (const [engine, names] of targets) for (const name of names) status.profiles[name] = outcomes.get(engine)!;
  const json = JSON.stringify({ version: 1, ...status }, null, 2);
  if (json === lastStatus) return;
  await writeUserScriptsStatus(json);
  lastStatus = json;
}

function schedule() {
  if (running) {
    again = true;
    return;
  }
  running = (async () => {
    do {
      again = false;
      try {
        await reconcile();
      } catch (error) {
        console.warn("[scripts] couldn't apply the bay scripts", error);
      }
    } while (again && enabled());
    running = null;
  })();
}

let started = false;

export function startUserScripts() {
  if (started || !userScriptsAvailable()) return;
  started = true;
  onUserScriptsChange(schedule);
  let watching = false;
  let key = "";
  const sync = (s: BrowserState) => {
    const on = s.settings.cliControl ?? false;
    const nextKey = on ? targetsKey(scriptsTargets(s)) : "";
    if (on === watching && nextKey === key) return;
    watching = on;
    key = nextKey;
    watchUserScripts(on);
    if (on) schedule();
  };
  sync(useBrowser.getState());
  useBrowser.subscribe((s, prev) => {
    if (s.settings.cliControl !== prev.settings.cliControl || s.spaceOrder !== prev.spaceOrder || s.spaces !== prev.spaces) sync(s);
  });
}

if (__DEV__) (globalThis as { bayUserScripts?: unknown }).bayUserScripts = { schedule, applied, scriptsTargets };
