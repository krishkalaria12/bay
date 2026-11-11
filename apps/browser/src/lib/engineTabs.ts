// Chrome's tab strips and the store. Chrome commits; the engine reports each
// change as a transaction with a revision and its cause. Transactions apply in revision order. The app's own
// changes come back with their command and only update the mirror; Chrome's become the same change in the store
// (store/tabStripSync.ts). After every change the store's plan for each strip is compared with Chrome's, and a command
// goes out where they differ: one per strip at a time, and never the same command twice against the same strip.
//
// The service owns the engine's side of it: the listener that reads the transactions, the snapshot they are applied
// to, and what happens when that snapshot cannot be read. The reconciliation itself stays as it is — synchronous,
// batched in a microtask, and a command goes out only where the store and Chrome disagree.
import {
  chromeWindows,
  devWindowAction,
  engineInfo,
  onTabStripTransaction,
  sendTabStripCommand,
  tabStrips,
  type StripState,
  type TabStripCommand,
  type TabStripTransaction,
} from "@bay/chromium";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { Operation } from "../effect/errors";
import { Diagnostics } from "../effect/ports/diagnostics";
import { useBrowser, type BrowserState } from "../store/browserStore";
import { changedIds } from "../store/recordDiff";
import { chromeChanged, groupStep, stripActual, stripPlan, type GroupBindings } from "../store/tabStripSync";

/** The engine could not report its tab strips. */
export class EngineTabsFailure extends TaggedError("EngineTabsFailure")<{
  readonly operation: Operation;
  readonly message: string;
  readonly cause: unknown;
}> {}

/** The engine's tab strips, as the app reaches them. */
export class EngineTabsEngine extends Context.Service<
  EngineTabsEngine,
  {
    /** Registers the one handler for the engine's transactions. The answer gives the handler back. */
    readonly onTransaction: (listener: (transaction: TabStripTransaction) => void) => Effect.Effect<() => void>;
    /** The strips as they are now, with the revision they are at. */
    readonly snapshot: () => Effect.Effect<TabStripTransaction, EngineTabsFailure>;
  }
>()("bay/EngineTabsEngine") {
  static readonly layer = Layer.succeed(EngineTabsEngine)({
    onTransaction: (listener) =>
      Effect.sync(() => {
        const subscription = onTabStripTransaction(listener);

        return () => subscription.remove();
      }),
    snapshot: () =>
      Effect.tryPromise({
        try: () => tabStrips(),
        catch: (cause) =>
          new EngineTabsFailure({
            operation: { name: "engineTabs.snapshot" },
            message: "The engine's tab strips could not be read.",
            cause,
          }),
      }),
  });
}

const mirror = new Map<number, StripState>();

// -1 until the first snapshot arrives; transactions before it wait.
let lastRev = -1;
let early: TabStripTransaction[] = [];

// Tabs the app has seen in a strip (a tab Chrome made is Chrome's to place only the first time).
const seen = new Set<string>();

// The command each strip is waiting for (an arrange or group with the tabs it lists; the store group a new Chrome
// group is made for).
type Kind = "arrange" | "activate" | "group";

const inflight = new Map<number, { kind: Kind; cmd: number; keys?: string[]; makes?: string; successor?: boolean }>();

// Chrome's group ids → the store's.
const groups: GroupBindings = new Map();

// What was last sent to each strip, against which of its states: a plan Chrome couldn't reach isn't sent again
// until something other than the app's commands changes the strip.
const tried = new Map<string, { sig: string; since: number }>();
const changedAt = new Map<number, number>();

if (__DEV__) {
  // SAFETY: nnChromeTabs is the tab-strip sync's own dev-harness surface, read only by tests.
  (globalThis as { nnChromeTabs?: unknown }).nnChromeTabs = {
    chromeWindows,
    engineInfo,
    devWindowAction,
    strips: () => [...mirror.values()],
    state: () => ({ lastRev, inflight: Object.fromEntries(inflight), tried: Object.fromEntries(tried), groups: Object.fromEntries(groups) }),
  };
}

// Whether a tab came, went or changed what the plans read of it (stripPlan, groupStep: its window, profile and pin).
// A page's title, address or icon changing doesn't project again.
function placed(s: BrowserState, prev: BrowserState) {
  return changedIds(s.tabs, prev.tabs).some((id) => {
    const a = s.tabs[id];
    const b = prev.tabs[id];

    return !a || !b || a.windowId !== b.windowId || a.spaceId !== b.spaceId || a.pinned !== b.pinned;
  });
}

// MARK: Chrome → store

function receive(tx: TabStripTransaction) {
  if (tx.rev <= lastRev) return;
  lastRev = tx.rev;

  for (const [strip, f] of inflight) {
    if (f.cmd !== tx.cmd) continue;
    inflight.delete(strip);
    // The Chrome group made for a store group: whatever group its tabs are in now.
    const made = f.makes && tx.strips.find((x) => x.strip === strip)?.tabs.find((t) => t.key === f.keys?.[0])?.group;

    if (made && f.makes) groups.set(made, f.makes);
  }

  const start = useBrowser.getState();
  let s = start;

  for (const strip of tx.strips) {
    const before = mirror.get(strip.strip);

    if (strip.closed) mirror.delete(strip.strip);
    else mirror.set(strip.strip, strip);

    if (tx.cmd === null || tx.cmd < 0) changedAt.set(strip.strip, tx.rev);

    if (tx.cmd === null) {
      // A command of the app's own on its way to this strip comes after Chrome's change, and wins.
      const waiting = inflight.get(strip.strip);
      const siblings = [...mirror.values()].filter((x) => x.window === strip.window && x.strip !== strip.strip);
      s = chromeChanged(s, before, strip, {
        seen,
        siblings,
        groups,
        pending: {
          arranged: new Set(waiting?.kind === "arrange" ? waiting.keys : []),
          grouped: new Set(waiting?.kind === "group" ? waiting.keys : []),
          // The store's successor for a tab that closed gives way to a tab Chrome activated explicitly meanwhile
          // (an extension closing and activating in one go), as in Chrome.
          active: waiting?.kind === "activate" && !waiting.successor,
        },
      });
    }

    for (const t of strip.tabs) if (t.key) seen.add(t.key);
  }

  if (seen.size > 2 * Object.keys(s.tabs).length + 64) for (const key of seen) if (!s.tabs[key]) seen.delete(key);

  if (s !== start) useBrowser.setState(s);
  scheduleProject();
}

// The snapshot the transactions that arrived before it are applied to: the strips as they are now, and the
// revision they are at.
function applySnapshot(snapshot: TabStripTransaction) {
  for (const strip of snapshot.strips) {
    mirror.set(strip.strip, strip);

    for (const t of strip.tabs) if (t.key) seen.add(t.key);
  }

  lastRev = snapshot.rev;
  const queued = early;
  early = [];

  for (const tx of queued) receive(tx);
  scheduleProject();
}

// MARK: Store → Chrome

let projectQueued = false;

function scheduleProject() {
  if (projectQueued || lastRev < 0) return;
  projectQueued = true;
  queueMicrotask(() => {
    projectQueued = false;
    project(useBrowser.getState());
  });
}

function project(s: BrowserState) {
  for (const strip of mirror.values()) {
    if (inflight.has(strip.strip)) continue;
    const plan = stripPlan(s, strip);

    if (!plan) continue;
    const actual = stripActual(strip, plan);
    // The shown tab first: Chrome's commands and extensions act on its active tab.
    const order = `${plan.keys.join(",")}|${plan.pinned}`;

    if (plan.active && plan.active !== actual.active) {
      // Chrome's active tab is gone from the store (it closed): the store's pick is a successor.
      const successor = !!actual.active && !s.tabs[actual.active];
      send(strip.strip, "activate", plan.active, { op: "activate", strip: strip.strip, key: plan.active }, undefined, successor);
    } else if (order !== `${actual.keys.join(",")}|${actual.pinned}`) {
      send(strip.strip, "arrange", order, { op: "arrange", strip: strip.strip, keys: plan.keys, pinned: plan.pinned });
    } else {
      const step = groupStep(s, strip, groups);

      if (step) {
        const { makes, ...rest } = step;
        send(strip.strip, "group", JSON.stringify(step), { op: "group", strip: strip.strip, ...rest }, makes);
      }
    }
  }
}

function send(strip: number, kind: Kind, sig: string, command: TabStripCommand, makes?: string, successor?: boolean) {
  const since = changedAt.get(strip) ?? 0;
  const last = tried.get(`${strip}:${kind}`);

  if (last?.sig === sig && last.since === since) return;
  tried.set(`${strip}:${kind}`, { sig, since });
  inflight.set(strip, { kind, cmd: sendTabStripCommand(command), ...(command.op !== "activate" ? { keys: command.keys } : undefined), makes, successor });
}

// MARK: The service

export class EngineTabsService extends Context.Service<
  EngineTabsService,
  {
    /** Reads the engine's transactions and the strips they are applied to. */
    readonly start: Effect.Effect<void>;
    /** Gives the engine's transactions back. */
    readonly stop: Effect.Effect<void>;
  }
>()("bay/EngineTabsService") {
  static readonly layer = Layer.effect(
    EngineTabsService,
    Effect.gen(function* () {
      const engine = yield* EngineTabsEngine;
      const diagnostics = yield* Diagnostics;
      const scope = yield* Scope.Scope;

      // The listener the engine's transactions reach, and the subscription that projects the store's changes.
      let remove: (() => void) | undefined;
      let stopStore: (() => void) | undefined;

      // Whether the strips are known: the app sends nothing before they are.
      let known = false;

      // Whether the strips are being read: one read at a time, however many things ask for it.
      let reading = false;

      // Whether a failure has been reported: it is reported once, not once per attempt.
      let reported = false;

      // The failure behind the snapshot, as an error the diagnostics can carry.
      const asError = (cause: unknown): Error => (cause instanceof Error ? cause : new Error(String(cause)));

      // A branch of the reconciliation's work: it starts at once, it runs in the app's scope, and it is interrupted
      // when that scope closes.
      const branch = (work: Effect.Effect<void>): void => {
        void Effect.runFork(Effect.forkIn(work, scope, { startImmediately: true }));
      };

      // A failure is reported once, where every other failure goes. A read that works again lets the next failure
      // be reported too: one outage is one report, not one per attempt.
      const report = (failure: EngineTabsFailure): Effect.Effect<void> => {
        if (reported) return Effect.void;
        reported = true;

        return diagnostics.report({
          operation: failure.operation,
          message: failure.message,
          cause: asError(failure.cause),
        });
      };

      // The strips as they are now. The transactions that arrived before it are applied to it, and only then does
      // the app send a command: the state is read again before anything goes out.
      const readSnapshot = (): Effect.Effect<void, EngineTabsFailure> =>
        Effect.gen(function* () {
          const snapshot = yield* engine.snapshot();

          yield* Effect.sync(() => {
            applySnapshot(snapshot);
            known = true;
            reported = false;
          });
        });

      // The strips are asked for when they are not known and something needs them: the engine is talking, or the
      // app wants to change a strip it cannot see yet. Nothing goes out until the state is in.
      const ensureSnapshot = (): void => {
        if (known || reading) return;
        reading = true;

        branch(
          readSnapshot().pipe(
            Effect.catch((failure) => report(failure)),
            Effect.ensuring(
              Effect.sync(() => {
                reading = false;
              }),
            ),
          ),
        );
      };

      // The engine's transactions: the ones that arrive before the snapshot wait for it.
      const onTransaction = (transaction: TabStripTransaction): void => {
        // The state is not known yet: the transaction waits for it, and the engine is asked for it.
        if (!known) {
          early.push(transaction);
          ensureSnapshot();

          return;
        }

        receive(transaction);
      };

      // The listener and the subscription are given back, once.
      const stopListening = (): void => {
        remove?.();
        remove = undefined;
        stopStore?.();
        stopStore = undefined;

        // What the app believed about the strips is stale now: a shell that starts again reads the state again.
        known = false;
      };

      const start = Effect.gen(function* () {
        // The engine is read once: a second start would read its transactions twice.
        if (remove) return;

        remove = yield* engine.onTransaction(onTransaction);
        stopStore = useBrowser.subscribe((s, prev) => {
          if (s.windows !== prev.windows || s.tabLists !== prev.tabLists || s.groups !== prev.groups || placed(s, prev)) {
            // The app wants to change a strip it cannot see yet: the state is read before anything goes out.
            if (!known) {
              ensureSnapshot();

              return;
            }

            scheduleProject();
          }
        });

        // The app's scope owns the listener: it gives it back when it closes, once.
        yield* Scope.addFinalizer(scope, Effect.sync(stopListening));

        // The strips are read now. A snapshot that could not be read is reported once, and the app sends nothing
        // until the state is known: the engine is asked again when it talks, or when the app wants to change a
        // strip it cannot see.
        reading = true;

        yield* readSnapshot().pipe(
          Effect.catch((failure) => report(failure)),
          Effect.ensuring(
            Effect.sync(() => {
              reading = false;
            }),
          ),
        );
      });

      const stop = Effect.sync(stopListening);

      return EngineTabsService.of({ start, stop });
    }),
  );
}

/** What the engine's tab strips can do. */
export type EngineTabs = EngineTabsService["Service"];
