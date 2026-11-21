// Chrome's history, and the app's view of it.
//
// The view is plain and immediate: a change Chrome reports is shown at once, and the store is written once. The
// reads are a program: a profile's history is read from Chrome, the changes that arrive while it is read are kept
// and applied to the list it read, and the app's old history.json is moved into Chrome once.
//
// This module is the service: it holds the state the view and the reads share, and the port they reach Chrome
// through. The app's entry points are in lib/history.ts.
import { addHistoryVisits, onHistoryChanged, queryHistory, watchHistory, type EngineHistoryEntry, type HistoryChange } from "@bay/chromium";
import { readDocument, removeDocument } from "@bay/desktop";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as v from "valibot";
import type { Operation } from "../effect/errors";
import { Diagnostics } from "../effect/ports/diagnostics";
import type { BrowserState, BrowserStore } from "../store/browserStore";
import { AuthorityStore } from "../effect/ports/store";
import { MAX_HISTORY, MAX_VISIT_TIMES } from "../store/constants";
import { engineProfileFor, isIncognitoSpace } from "../store/model";
import type { HistoryEntry } from "../store/types";
import { CHROME_HISTORY_KEEPS_MS, HISTORY_CHUNK, LEGACY_HISTORY_FILE, LEGACY_HISTORY_KEPT_MS, LEGACY_HISTORY_TOLERANCE_MS } from "./constants";

// MARK: Chrome's history

/** Chrome's history could not be read, watched or written to. */
export class HistoryError extends TaggedError("HistoryError")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** Chrome's history, as the app reaches it. */
export class HistoryEngine extends Context.Service<
  HistoryEngine,
  {
    /** Starts Chrome's reports of the profile's changes. */
    readonly watch: (profile: string) => Effect.Effect<void, HistoryError>;
    /** Reads the profile's history: one row per URL, with its visits. */
    readonly query: (profile: string, maxUrls: number, maxVisits: number) => Effect.Effect<EngineHistoryEntry[], HistoryError>;
    /** Adds the visits the profile doesn't have yet. */
    readonly add: (profile: string, pages: { url: string; title: string; visitTimes: number[] }[], toleranceMs: number) => Effect.Effect<number, HistoryError>;
  }
>()("bay/HistoryEngine") {
  static readonly layer = Layer.succeed(HistoryEngine)({
    watch: (profile) =>
      Effect.tryPromise({
        try: () => watchHistory(profile),
        catch: (cause) => new HistoryError({ operation: { name: "history.watch", resource: profile }, cause }),
      }),
    query: (profile, maxUrls, maxVisits) =>
      Effect.tryPromise({
        try: () => queryHistory(profile, maxUrls, maxVisits),
        catch: (cause) => new HistoryError({ operation: { name: "history.query", resource: profile }, cause }),
      }),
    add: (profile, pages, toleranceMs) =>
      Effect.tryPromise({
        try: () => addHistoryVisits(profile, pages, toleranceMs),
        catch: (cause) => new HistoryError({ operation: { name: "history.add", resource: profile }, cause }),
      }),
  });
}

// MARK: The view

// The pages the app's History, command bar and sync show: Chrome also keeps extension pages (a hidden helper's
// chrome-extension:// page among them), which the app never listed.
export const shownInHistory = (url: string) => /^(https?|file):/i.test(url);

const toEntry = (e: EngineHistoryEntry): HistoryEntry => ({
  url: e.url,
  title: e.title,
  favicon: null,
  visits: e.visits,
  lastVisit: e.visitTimes.length ? e.visitTimes[e.visitTimes.length - 1]! : 0,
  visitTimes: e.visitTimes,
});

const engineProfiles = (s: Pick<BrowserState, "spaces">) => [
  ...new Set(
    Object.keys(s.spaces)
      .filter((id) => !isIncognitoSpace(id))
      .map((id) => engineProfileFor(id, s.spaces)),
  ),
];

const profilesUsing = (s: Pick<BrowserState, "spaces">, engine: string) =>
  Object.keys(s.spaces).filter((id) => !isIncognitoSpace(id) && engineProfileFor(id, s.spaces) === engine);

function viewOf(browser: BrowserStore, engine: string): HistoryEntry[] {
  const s = browser.getState();

  for (const id of profilesUsing(s, engine)) if (s.history[id]) return s.history[id]!;

  return [];
}

/**
 * Shows `list` for the engine profile. `floor`: visits at or before it may be missing from the view (it holds
 * Chrome's newest MAX_HISTORY URLs); a read sets it, and it only rises while the view fills from events.
 *
 * `ready`: sync may use a view only once history.json is in Chrome; before, its visits would read as deleted.
 */
function setView(browser: BrowserStore, engine: string, list: HistoryEntry[], floor: number | undefined, ready: boolean) {
  browser.setState((s) => {
    const ids = profilesUsing(s, engine);
    const was = ids.map((id) => s.historyFloor[id] ?? -Infinity).reduce((a, b) => Math.max(a, b), -Infinity);
    const full = list.length >= MAX_HISTORY ? list[list.length - 1]!.lastVisit : -Infinity;
    const next = Math.max(floor ?? was, full);

    if (ids.every((id) => s.history[id] === list && (s.historyFloor[id] ?? -Infinity) === next && (!ready || s.historyReady[id]))) return {};

    // An absent floor means the complete history is visible. Keep the unbounded
    // value out of state so coordinator snapshots remain JSON serializable.
    const historyFloor = { ...s.historyFloor };

    for (const id of ids) {
      if (next === -Infinity) delete historyFloor[id];
      else historyFloor[id] = next;
    }

    return {
      history: { ...s.history, ...Object.fromEntries(ids.map((id) => [id, list])) },
      historyFloor,
      ...(ready ? { historyReady: { ...s.historyReady, ...Object.fromEntries(ids.map((id) => [id, true as const])) } } : undefined),
    };
  });
}

// MARK: Changes

const byLastVisit = (a: HistoryEntry, b: HistoryEntry) => b.lastVisit - a.lastVisit;

export function applyHistoryChange(list: HistoryEntry[], change: Exclude<HistoryChange, { kind: "deleted"; all: true }>): HistoryEntry[] {
  switch (change.kind) {
    case "visit": {
      if (!shownInHistory(change.url)) return list;
      const old = list.find((h) => h.url === change.url);

      if (old?.visitTimes?.includes(change.at)) return list;
      const times = [...(old?.visitTimes ?? []), change.at].sort((a, b) => a - b).slice(-MAX_VISIT_TIMES);

      const entry: HistoryEntry = {
        url: change.url,
        title: change.title || old?.title || "",
        favicon: null,
        visits: Math.max(change.visits, 1),
        lastVisit: times[times.length - 1]!,
        visitTimes: times,
      };

      const rest = list.filter((h) => h !== old);
      const at = rest.findIndex((h) => h.lastVisit <= entry.lastVisit);

      return (at < 0 ? [...rest, entry] : [...rest.slice(0, at), entry, ...rest.slice(at)]).slice(0, MAX_HISTORY);
    }

    case "modified": {
      const rows = new Map(change.rows.map((r) => [r.url, r]));
      let changed = false;

      const next = list.map((h) => {
        const row = rows.get(h.url);

        if (!row || ((row.title === h.title || !row.title) && row.visits === h.visits)) return h;
        changed = true;

        return { ...h, title: row.title || h.title, visits: row.visits };
      });

      return changed ? next : list;
    }

    case "deleted": {
      const gone = new Set(change.urls);
      const next = list.filter((h) => !gone.has(h.url));

      return next.length === list.length ? list : next;
    }
  }
}

// MARK: Reading

/** What a profile's read is doing. */
type Read = {
  // The changes Chrome reported while the read was running.
  queued: HistoryChange[];
  // The history was emptied: the list has to be read again.
  again: boolean;
  // The read that is running now, and what a second caller waits for.
  done: Deferred.Deferred<void> | undefined;
};

// MARK: The service

export class History extends Context.Service<
  History,
  {
    /** Starts watching Chrome's history and reads each profile's. */
    readonly start: Effect.Effect<void>;
    /** Stops watching Chrome's history. */
    readonly stop: Effect.Effect<void>;
    /** Reads a profile's history from Chrome and shows it. */
    readonly read: (profile: string) => Effect.Effect<void>;
    /** Reads every profile's history from Chrome again. */
    readonly reload: () => Effect.Effect<void>;
    /** Moves the app's old history.json into Chrome. */
    readonly migrate: (options?: { now?: number; keepMs?: number }) => Effect.Effect<"none" | "moved" | "kept">;
  }
>()("bay/History") {
  static readonly layer = Layer.effect(
    History,
    Effect.gen(function* () {
      const browser = (yield* AuthorityStore).store;
      const store = () => browser.getState();
      const view = (profile: string) => viewOf(browser, profile);
      const show = (profile: string, list: HistoryEntry[], floor: number | undefined, ready: boolean) => setView(browser, profile, list, floor, ready);
      const engine = yield* HistoryEngine;
      const diagnostics = yield* Diagnostics;
      const scope = yield* Scope.Scope;

      // The reads that are running, by profile. A profile that isn't here has no read in flight.
      const reads = new Map<string, Read>();

      // The profiles whose history has been read from Chrome.
      const loaded = new Set<string>();

      // Profiles whose old file is being moved in: their views are read again once it's done, not per added visit.
      const migrating = new Set<string>();

      // With an old history.json to move in, the views are first read (and Chrome's changes watched) once it's in:
      // watching during the move sent the JS one event per moved visit (~88,000 for a long-used profile, ~200 ms of
      // the startup JS), all of them ignored, and the views are read again after it anyway.
      let moving = false;

      // Moves when the service stops: a read that was already waiting for Chrome does not write its answer.
      let generation = 0;

      // Sync may use a view only once history.json is in Chrome: before, its visits would read as deleted.
      let legacyMoved = false;

      const readOf = (profile: string): Read => {
        const existing = reads.get(profile);

        if (existing) return existing;

        const created: Read = { queued: [], again: false, done: undefined };

        reads.set(profile, created);

        return created;
      };

      // The profiles the app asks to read. Chrome's report of an emptied history asks for one.
      const requests = yield* Queue.unbounded<string>();

      // A failure is reported once, where every other failure goes.
      const asError = (cause: unknown): Error => {
        if (cause instanceof Error) return cause;

        const squashed = Cause.isCause(cause) ? Cause.squash(cause) : cause;

        return squashed instanceof Error ? squashed : new Error(String(squashed));
      };

      const report = (operation: Operation, cause: unknown) => {
        const error = asError(cause);

        return diagnostics.report({ operation, message: error.message, cause: error });
      };

      const readProfile = (profile: string, state: Read): Effect.Effect<void, HistoryError> =>
        Effect.gen(function* () {
          const run = generation;

          do {
            state.again = false;
            state.queued = [];

            yield* engine.watch(profile);

            const entries = yield* engine.query(profile, MAX_HISTORY, MAX_VISIT_TIMES);

            // The service stopped while Chrome was answering: the answer is not this store's to show.
            if (run !== generation) return;
            // Chrome had more URLs than the view reads: the older ones may be missing (shown or not).
            const floor = entries.length >= MAX_HISTORY ? Math.min(...entries.map((e) => e.visitTimes.at(-1) ?? 0)) : -Infinity;

            let list = entries
              .filter((e) => shownInHistory(e.url))
              .map(toEntry)
              .sort(byLastVisit);

            for (const change of state.queued) if (!(change.kind === "deleted" && change.all)) list = applyHistoryChange(list, change);

            if (state.queued.some((c) => c.kind === "deleted" && c.all)) state.again = true;

            show(profile, list, floor, legacyMoved);
            loaded.add(profile);
          } while (state.again);
        });

      const read = (profile: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const state = readOf(profile);
          const running = state.done;

          if (running) {
            // A read is running: it reads again, and this caller waits for it.
            state.again = true;
            yield* Deferred.await(running);

            return;
          }

          const done = yield* Deferred.make<void>();

          state.done = done;

          for (;;) {
            const exit = yield* Effect.exit(readProfile(profile, state));

            if (Exit.isSuccess(exit)) break;

            yield* report({ name: "history.read", resource: profile }, exit.cause);

            // A failed query consumes its own request, but a change or another caller that arrived while it
            // waited still needs a pass. Without a new signal, leave the failure for the next request.
            if (!state.again && !state.queued.length) break;
          }

          state.done = undefined;
          reads.delete(profile);

          yield* Deferred.done(done, Exit.succeed(undefined));
        });

      // Each profile progresses independently. Another request for a running profile joins its next pass
      // instead of creating another waiting fiber. Closing the app stops every profile's read.
      const dispatch = (profile: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const state = reads.get(profile);

          if (state?.done) {
            state.again = true;

            return;
          }

          yield* Effect.forkIn(read(profile), scope, { startImmediately: true });
        });

      yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(requests), dispatch)));

      const wanted = () => engineProfiles(store()).filter((profile) => !loaded.has(profile) && !reads.has(profile));

      const loadAll = (): Effect.Effect<void> => Effect.forEach(wanted(), (profile) => read(profile), { concurrency: "unbounded", discard: true });

      const reload = (): Effect.Effect<void> =>
        Effect.forEach(engineProfiles(store()), (profile) => read(profile), { concurrency: "unbounded", discard: true });

      const migrate = ({ now = Date.now(), keepMs = LEGACY_HISTORY_KEPT_MS } = {}): Effect.Effect<"none" | "moved" | "kept"> =>
        Effect.gen(function* () {
          let file: LegacyFile | null = null;

          try {
            const json = readDocument(LEGACY_HISTORY_FILE);

            // SAFETY: JSON.parse yields the legacy history document shape written by the old app.
            file = json ? (JSON.parse(json) as LegacyFile) : null;
          } catch (error) {
            yield* report({ name: "history.migrate.read", resource: LEGACY_HISTORY_FILE }, error);

            return "kept" as const;
          }

          if (!file) return "none" as const;

          const s = store();
          const perEngine = new Map<string, HistoryEntry[]>();

          for (const [spaceId, list] of Object.entries(file.history ?? {})) {
            if (!s.spaces[spaceId] || isIncognitoSpace(spaceId) || !Array.isArray(list)) continue;
            const profile = engineProfileFor(spaceId, s.spaces);

            // Profiles sharing data saved the same list.
            if (!perEngine.has(profile)) perEngine.set(profile, list);
          }

          for (const profile of perEngine.keys()) migrating.add(profile);

          const addAll = Effect.gen(function* () {
            for (const [profile, list] of perEngine) {
              const pages = list
                .filter((e) => e && v.is(v.string(), e.url))
                .map((e) => ({
                  url: e.url,
                  title: e.title ?? "",
                  visitTimes: (e.visitTimes?.length ? e.visitTimes : [e.lastVisit]).filter((t) => v.is(v.number(), t) && t > now - CHROME_HISTORY_KEEPS_MS),
                }))
                .filter((p) => p.visitTimes.length);

              // One add at a time per profile: Chrome checks what a URL has, then adds what's missing, so two adds
              // of the same visit at once would both add it.
              for (let i = 0; i < pages.length; i += HISTORY_CHUNK) yield* engine.add(profile, pages.slice(i, i + HISTORY_CHUNK), LEGACY_HISTORY_TOLERANCE_MS);
            }
          });

          const added = yield* Effect.exit(addAll);

          // The profiles are moved in whatever happened: the file is only deleted once Chrome has them.
          migrating.clear();

          if (Exit.isFailure(added)) {
            yield* report({ name: "history.migrate.add" }, added.cause);

            return "kept" as const;
          }

          if (keepMs) {
            // The file is kept for a while: a launch that stops halfway starts over.
            yield* Effect.forkIn(
              Effect.andThen(
                Effect.sleep(Duration.millis(keepMs)),
                Effect.sync(() => removeDocument(LEGACY_HISTORY_FILE)),
              ),
              scope,
            );
          } else {
            removeDocument(LEGACY_HISTORY_FILE);
          }

          return "moved" as const;
        });

      const changed = (change: HistoryChange) => {
        const profile = change.profile;

        if (migrating.has(profile)) return;

        const state = reads.get(profile);

        if (state) {
          state.queued.push(change);

          return;
        }

        if (!loaded.has(profile)) return;

        if (change.kind === "deleted" && change.all) {
          // The history went: it is read again, in the app's scope.
          Queue.offerUnsafe(requests, profile);

          return;
        }

        show(profile, applyHistoryChange(view(profile), change), undefined, legacyMoved);
      };

      const onSpaces = (s: BrowserState, prev: BrowserState) => {
        if (s.spaces === prev.spaces) return;

        // A profile that appeared is read. The read runs in the app's scope, so it stops when the app does.
        if (!moving) for (const profile of wanted()) Queue.offerUnsafe(requests, profile);

        // A profile sharing another's data shows its list at once.
        for (const id of Object.keys(s.spaces)) {
          if (prev.spaces[id] || isIncognitoSpace(id) || s.history[id]) continue;
          const list = view(engineProfileFor(id, s.spaces));

          if (list.length) show(engineProfileFor(id, s.spaces), list, undefined, legacyMoved);
        }
      };

      // The listener and the subscription the app's history holds, and the stop that gives them back.
      let stopWatching: (() => void) | undefined;

      // What the history remembers between reads: the profiles it has read, and whether the app's old file is in
      // Chrome yet.
      const forget = () => {
        loaded.clear();
        reads.clear();
        legacyMoved = false;
        moving = false;
      };

      const stopWatchingNow = () => {
        generation++;
        stopWatching?.();
        stopWatching = undefined;
        forget();
      };

      const start = Effect.suspend((): Effect.Effect<void> => {
        if (stopWatching) return Effect.void;

        const events = onHistoryChanged(changed);
        const stopSubscription = browser.subscribe(onSpaces);

        stopWatching = () => {
          events.remove();
          stopSubscription();
        };

        // A stop while the old file moves in ends this start: a later start reads the views again.
        const run = generation;

        return Effect.gen(function* () {
          // The app's scope owns the listener and the subscription.
          yield* Scope.addFinalizer(scope, Effect.sync(stopWatchingNow));

          moving = readDocument(LEGACY_HISTORY_FILE) !== null;

          if (!moving) yield* loadAll();

          const result = yield* migrate();

          if (run !== generation) return;

          legacyMoved = result !== "kept";

          if (moving) {
            moving = false;
            yield* loadAll();
          } else if (result === "moved") {
            yield* reload();
          } else if (legacyMoved) {
            for (const profile of loaded) show(profile, view(profile), undefined, legacyMoved);
          }
        });
      });

      const stop = Effect.sync(stopWatchingNow);

      return History.of({ start, stop, read, reload, migrate });
    }),
  );
}

// MARK: The old file

type LegacyFile = { history?: Record<string, HistoryEntry[]> };
