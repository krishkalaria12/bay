// The live folders' refresh: one job per folder, the sources' answers kept apart, and the sweep that asks for the
// stale ones.
//
// A folder's refresh is a job: it runs once at a time, each source is asked on its own (one provider failing
// cannot erase another's items), and a folder that was deleted while it ran writes nothing.
import { onWindowEvent } from "@bay/desktop";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { Scheduler } from "../effect/ports/scheduler";
import { useBrowser } from "../store/browserStore";
import { activeTabId, pinnedPage } from "../store/model";
import { SOURCES, type LiveSource } from "./sources";
import { applyFetch, finishCompleting, live, removeFolder, setStatus, useLive } from "./activityStore";
import { LiveError, type CompletionState, type LiveFolder, type LiveItem, type LiveSourceId } from "./types";
import { COMPLETION_MS, REFRESH_INTERVAL_MS, STALE_ON_FOCUS_MS } from "./constants";

// How many sources are asked at once. Enough to be quick, few enough not to open a dozen connections.
const SOURCE_CONCURRENCY = 4;

// The sweep's period: the app asks for the folders that are stale, not for all of them.
const SWEEP_MS = 30_000;

// How long after the launch the first refresh waits: the app is still starting.
const FIRST_REFRESH_MS = 2_500;

const SECTION_ORDER = { authored: 0, review: 1, team: 2 } satisfies Record<string, number>;

function order(items: LiveItem[]): LiveItem[] {
  return [...items].sort((a, b) => (SECTION_ORDER[a.section ?? "authored"] ?? 0) - (SECTION_ORDER[b.section ?? "authored"] ?? 0) || b.updatedAt - a.updatedAt);
}

const asError = (cause: unknown): Error => (cause instanceof Error ? cause : new Error(String(cause)));

function describe(source: LiveSourceId, error: Error) {
  if (error instanceof LiveError) return { kind: error.kind, message: error.message, source };

  return { kind: "other" as const, message: String(error?.message ?? error), source };
}

/** The sources the folders ask, as the service reaches them. */
export class LiveSources extends Context.Service<LiveSources, Record<LiveSourceId, LiveSource>>()("bay/LiveSources") {
  static readonly layer = Layer.succeed(LiveSources)(SOURCES);
}

export class ActivityService extends Context.Service<
  ActivityService,
  {
    /** Refreshes a folder: the sources are asked, and the answers land in the store. */
    readonly refresh: (folderId: string) => Effect.Effect<void>;
    /** Starts the sweep, and the checks that ask for a folder the user is looking at. */
    readonly start: Effect.Effect<void>;
    /** Stops the sweep. */
    readonly stop: Effect.Effect<void>;
  }
>()("bay/ActivityService") {
  static readonly layer = Layer.effect(
    ActivityService,
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      const sources = yield* LiveSources;
      const scope = yield* Scope.Scope;

      // The refresh each folder is having now.
      const jobs = new Map<string, Fiber.Fiber<void>>();

      // The folders the app asks to refresh. The worker asks for them, one at a time.
      const requests = yield* Queue.unbounded<string>();

      // The sources this folder has answered for, so an item that arrives quietly is not shown as new.
      const fetchedSources = new Map<string, Set<LiveSourceId>>();

      const fetchSource = (source: LiveSourceId, folder: LiveFolder): Effect.Effect<LiveItem[], unknown> =>
        Effect.suspend(() =>
          Effect.tryPromise({
            try: () => sources[source].fetch(folder),
            catch: (cause) => cause,
          }),
        );

      const runFolder = (folderId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const folder = live().folders[folderId];

          if (!folder) return;

          const before = live();

          setStatus(folderId, { state: before.status[folderId]?.lastFetch ? "updating" : "initializing" });

          const prev = before.items[folderId] ?? [];
          const animating = new Set(before.completing[folderId] ?? []);

          // Each source is asked on its own: one that fails cannot erase another's items.
          const results = yield* Effect.forEach(folder.sources, (id) => Effect.exit(fetchSource(id, folder)), { concurrency: SOURCE_CONCURRENCY });

          const next: LiveItem[] = [];
          const failed: { source: LiveSourceId; error: Error }[] = [];

          results.forEach((r, i) => {
            const source = folder.sources[i]!;

            if (Exit.isSuccess(r)) next.push(...r.value);
            else {
              failed.push({ source, error: asError(r.cause) });
              next.push(...prev.filter((it) => it.source === source && !animating.has(it.id)));
            }
          });

          // The folder was deleted while it ran: nothing is written.
          if (!live().folders[folderId]) return;

          const ids = new Set(next.map((it) => it.id));
          const missing = prev.filter((it) => !ids.has(it.id) && !animating.has(it.id) && !failed.some((f) => f.source === it.source));
          const gone: Record<string, CompletionState> = {};

          for (const source of new Set(missing.map((it) => it.source))) {
            const resolve = sources[source].resolveGone;

            if (!resolve) continue;

            const resolved = yield* Effect.exit(
              Effect.tryPromise({
                try: () => resolve(missing.filter((it) => it.source === source)),
                catch: (cause) => cause,
              }),
            );

            if (Exit.isSuccess(resolved)) Object.assign(gone, resolved.value);
          }

          const firstFailure = failed[0];

          if (firstFailure && failed.length === folder.sources.length && !prev.length && !before.status[folderId]?.lastFetch) {
            setStatus(folderId, { state: "error", error: describe(firstFailure.source, firstFailure.error) });

            return;
          }

          const lastSources = fetchedSources.get(folderId);
          const quiet = new Set(lastSources ? next.flatMap((it) => (lastSources.has(it.source) ? [] : [it.id])) : []);

          fetchedSources.set(folderId, new Set(folder.sources.filter((id) => !failed.some((f) => f.source === id))));
          applyFetch(folderId, order(next), gone, Date.now(), quiet);

          if (firstFailure) setStatus(folderId, { state: "error", error: describe(firstFailure.source, firstFailure.error) });

          const leaving = Object.keys(gone);

          // The items that left are shown as leaving for a moment, then they are gone.
          if (leaving.length) {
            yield* Effect.forkIn(
              Effect.andThen(
                Effect.sleep(Duration.millis(COMPLETION_MS)),
                Effect.sync(() => finishCompleting(folderId, leaving)),
              ),
              scope,
            );
          }
        });

      const refresh = (folderId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const running = jobs.get(folderId);

          // A folder is refreshed once at a time: the second ask waits for the first.
          if (running) {
            yield* Fiber.join(running);

            return;
          }

          const fiber = yield* Effect.forkIn(runFolder(folderId), scope);

          jobs.set(folderId, fiber);

          yield* Fiber.join(fiber);

          jobs.delete(folderId);
        });

      // A refresh the app asks for and does not wait for.
      const ask = (folderId: string): void => {
        Queue.offerUnsafe(requests, folderId);
      };

      // The worker asks for the folders the app wants refreshed, in the app's scope.
      yield* Effect.forkIn(Effect.forever(Effect.flatMap(Queue.take(requests), (folderId) => refresh(folderId))), scope);

      const due = (id: string, maxAge: number) => {
        const f = live().folders[id];
        const st = live().status[id];

        return !!f && (!st?.lastFetch || Date.now() - st.lastFetch >= maxAge);
      };

      const start = Effect.gen(function* () {
        // The first refresh waits for the app to settle.
        yield* Effect.forkIn(
          Effect.andThen(
            Effect.sleep(Duration.millis(FIRST_REFRESH_MS)),
            Effect.sync(() => live().folderOrder.forEach((id) => ask(id))),
          ),
          scope,
        );

        // The sweep asks for the folders that are stale, on the app's shared grid.
        yield* scheduler.every({
          every: SWEEP_MS,
          needed: () => live().folderOrder.length > 0,
          watch: (changed) => useLive.subscribe((s, prev) => s.folderOrder !== prev.folderOrder && changed()),
          run: Effect.sync(() => {
            for (const id of live().folderOrder) if (due(id, REFRESH_INTERVAL_MS[live().folders[id]!.kind])) void ask(id);
          }),
        });

        const events = onWindowEvent((e) => {
          if (e.type === "focus") for (const id of live().folderOrder) if (due(id, STALE_ON_FOCUS_MS)) void ask(id);
        });

        const stopOrphans = useLive.subscribe((s, prev) => {
          if (s.folders !== prev.folders) {
            const folders = live().folders;

            for (const t of Object.values(useBrowser.getState().tabs))
              if (t.liveItem && !folders[t.liveItem.folderId]) useBrowser.getState().updateTab(t.id, { liveItem: undefined });
          }
        });

        const stopSpaces = useBrowser.subscribe((s, prev) => {
          if (s.spaces === prev.spaces) return;

          for (const f of Object.values(live().folders)) if (!s.spaces[f.spaceId]) removeFolder(f.id);
        });

        const stopPins = useBrowser.subscribe((s, prev) => {
          if (s.tabs === prev.tabs) return;

          for (const id in s.tabs) {
            const t = s.tabs[id]!;

            // Pinned (a tile or a row), it leaves its live folder.
            if (t.liveItem && pinnedPage(t) && !(prev.tabs[id] && pinnedPage(prev.tabs[id]!))) useBrowser.getState().updateTab(id, { liveItem: undefined });
          }
        });

        const lastNudge = new Map<string, number>();

        const stopWindows = useBrowser.subscribe((s, prev) => {
          if (s.windows === prev.windows) return;

          for (const windowId of s.windowOrder) {
            const before = activeTabId(prev, windowId);

            if (!before || before === activeTabId(s, windowId)) continue;

            const folderId = s.tabs[before]?.liveItem?.folderId;

            if (!folderId || Date.now() - (lastNudge.get(folderId) ?? 0) < 20_000) continue;

            lastNudge.set(folderId, Date.now());
            void Effect.runFork(
              Effect.andThen(
                Effect.sleep(Duration.millis(3_000)),
                Effect.sync(() => ask(folderId)),
              ),
            );
          }
        });

        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            events.remove();
            stopOrphans();
            stopSpaces();
            stopPins();
            stopWindows();
            fetchedSources.clear();
            jobs.clear();
          }),
        );
      });

      const stop = Effect.sync(() => {
        fetchedSources.clear();
        jobs.clear();
      });

      return ActivityService.of({ refresh, start, stop });
    }),
  );
}
