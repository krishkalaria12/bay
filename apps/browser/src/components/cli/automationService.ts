// The app's own scripts (Bay Scripts): the folder the user keeps them in, and the engine profiles they are
// loaded into.
//
// The reconciliation is a job: it runs once at a time, a change that arrives while it runs asks for another pass,
// and a folder that changed under it starts over. The generations keep a stale answer from being taken for a
// current one.
import { installExtension, listExtensions, reloadExtension, uninstallExtension, type InstalledExtension } from "@bay/chromium";
import { onUserScriptsChange, readUserScripts, watchUserScripts, writeUserScriptsStatus, type UserScriptsFolder } from "@bay/desktop";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { useBrowser, type BrowserState } from "../../store/browserStore";
import { engineProfile, isIncognitoSpace } from "../../store/model";

/** The scripts could not be applied. */
export class AutomationFailure extends TaggedError("AutomationFailure")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** What the app asked of the engine and the Mac for one script folder. */
export type ScriptsOutcome = { ok: true } | { disabled: true } | { removed: true } | { error: string };

type Wanted = "present" | "absent";

const enabled = () => useBrowser.getState().settings.cliControl ?? false;

/** The engine profiles the scripts go to, and the names they are known by. */
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

const BLOCKED = "Bay Scripts can only hold content scripts, and the engine blocked this copy.";

const withError = (unloaded: ScriptsOutcome, refused: string): ScriptsOutcome =>
  "error" in unloaded ? { error: `${refused} (and the loaded copy couldn't be removed: ${unloaded.error})` } : { error: refused };

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

// A folder that cannot be read: nothing is applied, and the run waits for the next one.
const failedFolder = (): UserScriptsFolder => ({ state: "empty", token: "" });

/** The native side of the scripts, as the service reaches it. */
export class AutomationEngine extends Context.Service<
  AutomationEngine,
  {
    readonly readScripts: () => Effect.Effect<UserScriptsFolder, AutomationFailure>;
    readonly watchScripts: (on: boolean) => Effect.Effect<void, AutomationFailure>;
    readonly writeStatus: (json: string) => Effect.Effect<void, AutomationFailure>;
    /** The Mac's own change to the folder. */
    readonly onScriptsChange: (listener: () => void) => () => void;
    readonly listExtensions: (profile: string) => Effect.Effect<InstalledExtension[], AutomationFailure>;
    readonly installExtension: (options: { path: string }, profile: string) => Effect.Effect<string, AutomationFailure>;
    readonly reloadExtension: (id: string, profile: string) => Effect.Effect<void, AutomationFailure>;
    readonly uninstallExtension: (id: string, profile: string) => Effect.Effect<void, AutomationFailure>;
  }
>()("bay/AutomationEngine") {
  static readonly layer = Layer.succeed(AutomationEngine)({
    readScripts: () =>
      Effect.tryPromise({
        try: () => readUserScripts(),
        catch: (cause) => new AutomationFailure({ operation: "scripts.read", cause }),
      }),
    watchScripts: (on) =>
      Effect.tryPromise({
        try: async () => watchUserScripts(on),
        catch: (cause) => new AutomationFailure({ operation: "scripts.watch", cause }),
      }),
    writeStatus: (json) =>
      Effect.tryPromise({
        try: () => writeUserScriptsStatus(json),
        catch: (cause) => new AutomationFailure({ operation: "scripts.status", cause }),
      }),
    onScriptsChange: (listener) => {
      const subscription = onUserScriptsChange(listener);

      return () => subscription.remove();
    },
    listExtensions: (profile) =>
      Effect.tryPromise({
        try: () => listExtensions(profile),
        catch: (cause) => new AutomationFailure({ operation: "scripts.list", cause }),
      }),
    installExtension: (options, profile) =>
      Effect.tryPromise({
        try: () => installExtension(options, profile),
        catch: (cause) => new AutomationFailure({ operation: "scripts.install", cause }),
      }),
    reloadExtension: (id, profile) =>
      Effect.tryPromise({
        try: () => reloadExtension(id, profile),
        catch: (cause) => new AutomationFailure({ operation: "scripts.reload", cause }),
      }),
    uninstallExtension: (id, profile) =>
      Effect.tryPromise({
        try: () => uninstallExtension(id, profile),
        catch: (cause) => new AutomationFailure({ operation: "scripts.uninstall", cause }),
      }),
  });
}

export class AutomationService extends Context.Service<
  AutomationService,
  {
    /** Watches the folder, and applies the scripts to the profiles that want them. */
    readonly start: Effect.Effect<void>;
    /** Asks for the scripts to be applied. */
    readonly schedule: Effect.Effect<void>;
  }
>()("bay/AutomationService") {
  static readonly layer = Layer.effect(
    AutomationService,
    Effect.gen(function* () {
      const engine = yield* AutomationEngine;
      const scope = yield* Scope.Scope;

      // The work the app asks for: one reconciliation at a time.
      const requests = yield* Queue.unbounded<void>();

      // What each profile was told last, and for which generation of the folder.
      const applied = new Map<string, { generation: number; wanted: Wanted; outcome: ScriptsOutcome }>();

      let lastStatus: string | null = null;
      let running = false;
      let again = false;

      const load = (profile: string, path: string): Effect.Effect<ScriptsOutcome> =>
        Effect.gen(function* () {
          const find = (match: (x: InstalledExtension) => boolean) => engine.listExtensions(profile).pipe(Effect.map((list) => list.find(match)));
          const existing = yield* find((x) => loadedFrom(x, path));

          if (existing && !existing.enabled && !existing.blockedByPolicy) {
            yield* engine.reloadExtension(existing.id, profile);

            return { disabled: true } as const;
          }

          const id = yield* engine.installExtension({ path }, profile);
          const loaded = yield* find((x) => x.id === id);

          if (!loaded) return { error: "The extension didn't load." } as const;

          if (loaded.enabled) return { ok: true } as const;

          if (loaded.blockedByPolicy) return { error: loaded.errors[0] ?? BLOCKED } as const;

          return loaded.state === "DISABLED" ? ({ disabled: true } as const) : ({ error: `The extension is ${loaded.state.toLowerCase()}.` } as const);
        }).pipe(Effect.catch((error) => Effect.succeed({ error: message(error.cause) })));

      const unload = (profile: string, path: string): Effect.Effect<ScriptsOutcome> =>
        Effect.gen(function* () {
          const list = yield* engine.listExtensions(profile);

          for (const ext of list.filter((x) => loadedFrom(x, path))) yield* engine.uninstallExtension(ext.id, profile);

          return { removed: true } as const;
        }).pipe(Effect.catch((error) => Effect.succeed({ error: message(error.cause) })));

      const reconcile = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (!enabled()) return;

          const folder = yield* engine.readScripts().pipe(Effect.catch(() => Effect.succeed(failedFolder())));

          if (!enabled() || again) return;

          if (folder.state === "empty" || folder.state === "busy" || folder.state === "pending") return;

          const generation = folder.generation ?? 0;
          const targets = scriptsTargets(useBrowser.getState());
          const outcomes = new Map<string, ScriptsOutcome>();
          const refused = folder.state === "invalid" ? folder.error : null;
          const loadPath = folder.state === "ready" ? folder.path : null;
          const unloadPath = folder.state === "absent" || folder.state === "invalid" ? folder.path : null;
          const wanted: Wanted = loadPath ? "present" : "absent";

          for (const profile of targets.keys()) {
            const done = applied.get(profile);
            const cached = refused === null && done?.generation === generation && done.wanted === wanted ? done.outcome : null;
            let outcome: ScriptsOutcome;

            if (cached) outcome = cached;
            else if (refused !== null) outcome = unloadPath ? withError(yield* unload(profile, unloadPath), refused) : { error: refused };
            else if (loadPath) outcome = yield* load(profile, loadPath);
            else if (unloadPath) outcome = yield* unload(profile, unloadPath);
            else outcome = { removed: true };

            // The folder changed while it was applied: the answer is stale, and the run starts over.
            const current = yield* engine.readScripts().pipe(Effect.catch(() => Effect.succeed(folder)));

            if (current.token !== folder.token) {
              applied.delete(profile);
              again = true;

              return;
            }

            outcomes.set(profile, outcome);

            if (!cached) applied.set(profile, { generation, wanted, outcome });

            if (!enabled()) return;
          }

          if (again || !enabled()) return;

          // The profiles are named by the user, and the same name may belong to more than one profile.
          const profiles: Record<string, ScriptsOutcome> = Object.create(null);

          const status: Status = { generation, profiles };

          for (const [profile, names] of targets) for (const name of names) profiles[name] = outcomes.get(profile)!;

          const json = JSON.stringify({ version: 1, ...status }, null, 2);

          if (json === lastStatus) return;

          yield* engine.writeStatus(json).pipe(Effect.catch(() => Effect.void));

          lastStatus = json;
        });

      const schedule = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (running) {
            again = true;

            return;
          }

          running = true;

          try {
            do {
              again = false;

              yield* reconcile();
            } while (again && enabled());
          } catch (error) {
            console.warn("[scripts] couldn't apply the bay scripts", error);
          } finally {
            running = false;
          }
        });

      // The work runs here, in the app's scope: it stops when the app does.
      yield* Effect.forkIn(Effect.forever(Effect.flatMap(Queue.take(requests), () => schedule())), scope);

      const start = Effect.gen(function* () {
        let watching = false;
        let key = "";

        const sync = (s: BrowserState): Effect.Effect<void> =>
          Effect.gen(function* () {
            const on = s.settings.cliControl ?? false;
            const nextKey = on ? targetsKey(scriptsTargets(s)) : "";

            if (on === watching && nextKey === key) return;

            watching = on;
            key = nextKey;

            yield* engine.watchScripts(on).pipe(Effect.catch(() => Effect.void));

            if (on) Queue.offerUnsafe(requests, undefined);
          });

        const stopListening = engine.onScriptsChange(() => Queue.offerUnsafe(requests, undefined));

        yield* sync(useBrowser.getState());

        const stopStore = useBrowser.subscribe((s, prev) => {
          if (s.settings.cliControl !== prev.settings.cliControl || s.spaceOrder !== prev.spaceOrder || s.spaces !== prev.spaces) {
            void Effect.runFork(sync(s));
          }
        });

        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            stopListening();
            stopStore();
          }),
        );
      });

      return AutomationService.of({
        start,
        schedule: Effect.sync(() => Queue.offerUnsafe(requests, undefined)),
      });
    }),
  );
}

type Status = { generation: number; profiles: Record<string, ScriptsOutcome> };
