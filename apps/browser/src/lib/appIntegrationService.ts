// The app's ties to the rest of the Mac: Handoff, AppleScript, and the answers to its notifications.
//
// Each is a native registration the app's scope owns: the listeners are registered once and given back when the
// scope closes, and the waits that gather a burst of changes into one update are the scope's too. A script's command
// is answered exactly once — with its result, with its failure, or, when the app's scope closes before it finished,
// with that. What a command does, and what the Mac is told about each window, stay plain (appMenuIntegration.ts).
import {
  onCommand,
  onNotificationResponse,
  onScriptCommand,
  replyToScript,
  setScriptState,
  setWindowActivity,
  type CommandEvent,
  type NotificationResponse,
  type ScriptCommand,
  type ScriptResult,
  type ScriptState,
} from "@bay/desktop";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { Operation } from "../effect/errors";
import { Diagnostics } from "../effect/ports/diagnostics";
import { useBrowser, type BrowserState } from "../store/browserStore";
import { changedIds } from "../store/recordDiff";
import { activeTabId } from "../store/model";

/** How long Handoff waits for the windows to settle before it tells the Mac. */
const HANDOFF_DEBOUNCE_MS = 250;

/** How long after launch Handoff first tells the Mac what each window shows. */
const HANDOFF_FIRST_MS = 1_000;

/** How long the script state waits for the app to settle before it is sent. */
const SCRIPT_STATE_DEBOUNCE_MS = 100;

/** What a script that was still running when the app's scope closed is told. */
const STOPPED = "Bay stopped before the command finished.";

// MARK: The port

/** The Mac could not do what was asked. */
export class IntegrationFailure extends TaggedError("IntegrationFailure")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** The Mac, as the app's integration reaches it. */
export class IntegrationEngine extends Context.Service<
  IntegrationEngine,
  {
    /** Registers a handler for the commands the menu runs. The answer gives it back. */
    readonly onCommand: (listener: (event: CommandEvent) => void) => Effect.Effect<() => void>;
    /** Registers a handler for the answers to the app's notifications. The answer gives it back. */
    readonly onNotificationResponse: (listener: (response: NotificationResponse) => void) => Effect.Effect<() => void>;
    /** Registers the one handler for the commands scripts send. The answer gives it back. */
    readonly onScriptCommand: (listener: (command: ScriptCommand) => void) => Effect.Effect<() => void>;
    /** Tells Handoff what a window shows: a web page, or nothing. */
    readonly setWindowActivity: (windowId: string, url: string | null, title: string | null) => Effect.Effect<void, IntegrationFailure>;
    /** Tells scripts what the app's windows and tabs are. */
    readonly setScriptState: (state: ScriptState) => Effect.Effect<void, IntegrationFailure>;
    /** Answers a script's command. */
    readonly replyToScript: (id: string, result: ScriptResult | null, error: string | null) => Effect.Effect<void, IntegrationFailure>;
  }
>()("bay/IntegrationEngine") {
  static readonly layer = Layer.succeed(IntegrationEngine)({
    onCommand: (listener) => subscribe(() => onCommand(listener)),
    onNotificationResponse: (listener) => subscribe(() => onNotificationResponse(listener)),
    onScriptCommand: (listener) => subscribe(() => onScriptCommand(listener)),
    setWindowActivity: (windowId, url, title) => nativeCall("handoff.activity", windowId, () => setWindowActivity(windowId, url, title)),
    setScriptState: (state) => nativeCall("script.state", undefined, () => setScriptState(state)),
    replyToScript: (id, result, error) => nativeCall("script.reply", id, () => replyToScript(id, result, error)),
  });
}

function subscribe(register: () => { remove: () => void }): Effect.Effect<() => void> {
  return Effect.sync(() => {
    const subscription = register();

    return () => subscription.remove();
  });
}

function nativeCall<A>(name: string, resource: string | undefined, run: () => A | Promise<A>): Effect.Effect<A, IntegrationFailure> {
  return Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new IntegrationFailure({ operation: { name, resource }, cause }),
  });
}

// MARK: The service

/** The app's own answers: what a command does, and what scripts see. */
export type IntegrationHandlers = {
  /** Runs one of the app's menu commands. */
  readonly command: (event: CommandEvent) => void;
  /** Acts on the answer to one of the app's notifications. */
  readonly notificationResponse: (response: NotificationResponse) => void;
  /** Runs a script's command. A failure is the script's error. */
  readonly runScript: (command: ScriptCommand) => Promise<ScriptResult | void>;
  /** The windows and tabs, as scripts see them. */
  readonly scriptState: (s: BrowserState) => ScriptState;
};

/** What a window shows Handoff: a web page in a regular window, or nothing. */
/** What Handoff is told about a window. */
export type WindowActivity = { readonly url: string | null; readonly title: string };

export function windowActivity(s: BrowserState, windowId: string): WindowActivity {
  const w = s.windows[windowId]!;
  const tabId = activeTabId(s, windowId);
  const tab = tabId ? s.tabs[tabId] : undefined;
  const url = !w.incognito && tab?.url && /^https?:/i.test(tab.url) ? tab.url : null;

  return { url, title: tab ? tab.customTitle || tab.title : "" };
}

export class AppIntegrationService extends Context.Service<
  AppIntegrationService,
  {
    /** Registers the app's commands, its notifications' answers, Handoff and AppleScript, once. */
    readonly start: (handlers: IntegrationHandlers) => Effect.Effect<void>;
    /** The script commands that are running and not yet answered. */
    readonly pendingScripts: () => number;
  }
>()("bay/AppIntegrationService") {
  static readonly layer = Layer.effect(
    AppIntegrationService,
    Effect.gen(function* () {
      const engine = yield* IntegrationEngine;
      const diagnostics = yield* Diagnostics;
      const scope = yield* Scope.Scope;

      const report = (failure: IntegrationFailure): Effect.Effect<void> =>
        diagnostics.report({
          operation: failure.operation,
          message: failure.message,
          cause: failure.cause instanceof Error ? failure.cause : new Error(String(failure.cause)),
        });

      // The runtime's own services (its clock among them), as the start found them: the work a native callback
      // starts runs with them, not with a bare default.
      let services: Context.Context<never> = Context.empty();

      // Work that starts now and belongs to the app's scope: it ends when the scope closes.
      const fork = (work: Effect.Effect<void>): void => {
        void Effect.runForkWith(services)(Effect.forkIn(work, scope, { startImmediately: true }));
      };

      // A trigger that gathers a burst of calls into one run, after a wait: one wait at a time, never a queue.
      const coalesce = (wait: number, work: () => Effect.Effect<void>) => {
        let waiting = false;

        return () => {
          if (waiting) return;

          waiting = true;

          fork(
            Effect.sleep(Duration.millis(wait)).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  waiting = false;

                  return work();
                }),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  waiting = false;
                }),
              ),
            ),
          );
        };
      };

      // MARK: Handoff

      // What the Mac was last told about each window: it is told again only when that changes.
      const told = new Map<string, string>();

      const syncHandoff = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          for (const id of useBrowser.getState().windowOrder) {
            // Earlier native updates may have waited while this window changed or closed.
            const current = useBrowser.getState();

            if (!current.windows[id]) continue;

            const { url, title } = windowActivity(current, id);
            const key = `${url}\n${title}`;

            if (told.get(id) === key) continue;

            told.set(id, key);

            yield* engine.setWindowActivity(id, url, title || null).pipe(Effect.catch(report));
          }

          for (const id of told.keys()) if (!useBrowser.getState().windows[id]) told.delete(id);
        });

      // MARK: AppleScript

      let lastState = "";
      let scriptState: ((s: BrowserState) => ScriptState) | undefined;

      const pushState = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (!scriptState) return;

          const state = scriptState(useBrowser.getState());
          const json = JSON.stringify(state);

          if (json === lastState) return;

          lastState = json;

          yield* engine.setScriptState(state).pipe(Effect.catch(report));
        });

      // The commands that are running: each is answered once, and the ones the scope ends are told so.
      const pending = new Set<string>();

      const reply = (id: string, result: ScriptResult | null, error: string | null): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (!pending.delete(id)) return;

          yield* engine.replyToScript(id, result, error).pipe(Effect.catch(report));
        });

      const runScript = (run: IntegrationHandlers["runScript"], command: ScriptCommand): Effect.Effect<void> =>
        Effect.gen(function* () {
          pending.add(command.id);

          const outcome = yield* Effect.tryPromise({ try: () => run(command), catch: (error) => error }).pipe(Effect.result);

          // The state goes out before the answer, so the script sees what its command changed.
          yield* pushState();

          if (outcome._tag === "Success") return yield* reply(command.id, outcome.success ?? {}, null);

          const error = outcome.failure;

          yield* reply(command.id, null, error instanceof Error ? error.message : String(error));
        }).pipe(Effect.onInterrupt(() => reply(command.id, null, STOPPED)));

      // MARK: Starting

      let started = false;

      const start = (handlers: IntegrationHandlers): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (started) return;

          started = true;
          services = yield* Effect.context<never>();
          scriptState = handlers.scriptState;

          const removeCommands = yield* engine.onCommand(handlers.command);
          const removeResponses = yield* engine.onNotificationResponse(handlers.notificationResponse);

          const handoffSoon = coalesce(HANDOFF_DEBOUNCE_MS, syncHandoff);
          const stateSoon = coalesce(SCRIPT_STATE_DEBOUNCE_MS, pushState);

          const stopStore = useBrowser.subscribe((s, prev) => {
            const windows = s.tabs !== prev.tabs || s.tabLists !== prev.tabLists || s.windows !== prev.windows;

            if (windows) handoffSoon();

            // Of `live` the state has only whether a tab is loading: a page's progress doesn't build it again.
            const loading = s.live !== prev.live && changedIds(s.live, prev.live).some((id) => !!s.live[id]?.isLoading !== !!prev.live[id]?.isLoading);

            if (windows || loading || s.spaces !== prev.spaces) stateSoon();
          });

          const removeScripts = yield* engine.onScriptCommand((command) => fork(runScript(handlers.runScript, command)));

          // The Mac hears about the windows once they have settled after launch.
          fork(Effect.sleep(Duration.millis(HANDOFF_FIRST_MS)).pipe(Effect.andThen(syncHandoff())));
          fork(pushState());

          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              removeCommands();
              removeResponses();
              removeScripts();
              stopStore();
              started = false;
            }),
          );
        });

      return AppIntegrationService.of({ start, pendingScripts: () => pending.size });
    }),
  );
}
