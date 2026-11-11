// The media work that belongs to a window: the screens a share can offer, the cast dialog a tab opened, and the
// engine's tasks the task manager lists.
//
// Each of these lives only while its window is open. A picker that closes stops looking for screens, a request that
// was answered or replaced is never answered again, and a task manager that closes stops asking the engine what it is
// doing. The listeners that hear the engine (its cast dialogs, its cast routes) are the app's: one each, however many
// windows are open. Playback, Picture in Picture and the marquee stay plain: they are the page's own state, not a job.
import {
  closeCastDialog,
  getDisplayMediaSources,
  killTask,
  listTasks,
  onCastDialog,
  onCastRoutes,
  setAutoPictureInPicture,
  setDisplayMediaPicker,
  showCastDialog,
  watchCastRoutes,
  type CastDialog,
  type CastRoute,
  type DisplayMediaRequest,
  type DisplayMediaSource,
  type EngineTask,
} from "@bay/chromium";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { create } from "zustand";
import type { Operation } from "../../effect/errors";
import { Diagnostics } from "../../effect/ports/diagnostics";
import { webviews } from "../../lib/webviews";
import { useBrowser, type BrowserState } from "../../store/browserStore";
import { activeTabId, engineProfile, incognitoSpaceId } from "../../store/model";
import { browserIdOf } from "../extensions/store";
import { TASK_POLL_MS } from "../taskManager/constants";
import { tabForBrowser } from "../window/pageState";
import { SHARE_SOURCES_REFRESH_MS } from "./constants";
import { useMedia } from "./state";

// MARK: The state the app shows

type CastStore = {
  /** The cast dialog each tab has open. */
  dialogs: Record<string, CastDialog>;
  /** The cast routes of each engine profile. */
  routes: Record<string, CastRoute[]>;
};

/** The cast dialogs the tabs have open, and the routes each profile can cast to. */
export const useCast = create<CastStore>()(() => ({ dialogs: {}, routes: {} }));

/** The profile a window's cast routes belong to: a private window has a profile of its own. */
export function castProfile(s: BrowserState, windowId: string): string {
  const w = s.windows[windowId];

  return !w ? "" : w.incognito ? incognitoSpaceId(windowId) : engineProfile(w.spaceId);
}

/** A page's request to share a screen, and the page it was made on. */
export type PendingDisplayMedia = DisplayMediaRequest & { pageUrl: string };

// MARK: The port

/** The native side could not answer. */
export class MediaFailure extends TaggedError("MediaFailure")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** The native side of the media work, as the service reaches it. */
export class MediaEngine extends Context.Service<
  MediaEngine,
  {
    /** The screens and windows a share can offer. */
    readonly sources: () => Effect.Effect<DisplayMediaSource[], MediaFailure>;
    /** Answers a page's request to share a screen: a source, or nothing. */
    readonly resolveDisplayMedia: (tabId: string, requestId: string, sourceId: string | null) => Effect.Effect<void, MediaFailure>;
    /** The capture id of a tab, for sharing that tab instead of a screen. */
    readonly captureSourceId: (tabId: string) => Effect.Effect<string | null, MediaFailure>;
    /** Registers the one handler for the engine's cast dialogs. The answer gives it back. */
    readonly onCastDialog: (listener: (dialog: CastDialog) => void) => Effect.Effect<() => void>;
    /** Registers the one handler for the cast routes of the app's profiles. The answer gives it back. */
    readonly onCastRoutes: (listener: (routes: { profile: string; routes: CastRoute[] }) => void) => Effect.Effect<() => void>;
    /** Opens the cast dialog of a browser. */
    readonly showCastDialog: (browserId: number) => Effect.Effect<void, MediaFailure>;
    /** Closes a cast dialog. */
    readonly closeCastDialog: (dialogId: number) => Effect.Effect<void, MediaFailure>;
    /** Asks the engine to watch a profile's cast routes. */
    readonly watchCastRoutes: (profile: string) => Effect.Effect<void, MediaFailure>;
    /** The app shows its own picker when a page asks to share a screen. */
    readonly usePicker: () => Effect.Effect<void, MediaFailure>;
    /** Whether a call pops out into its own window when the user leaves its tab. */
    readonly setAutoPictureInPicture: (on: boolean) => Effect.Effect<void, MediaFailure>;
    /** The engine's tasks. */
    readonly tasks: () => Effect.Effect<EngineTask[], MediaFailure>;
    /** Ends a task. */
    readonly killTask: (id: number) => Effect.Effect<void, MediaFailure>;
  }
>()("bay/MediaEngine") {
  static readonly layer = Layer.succeed(MediaEngine)({
    sources: () => nativeCall("media.sources", () => getDisplayMediaSources()),
    resolveDisplayMedia: (tabId, requestId, sourceId) =>
      nativeCall("media.answer", () => webviews.get(tabId)?.resolveDisplayMedia(requestId, sourceId)).pipe(Effect.asVoid),
    captureSourceId: (tabId) => nativeCall("media.capture", async () => (await webviews.get(tabId)?.mediaCaptureSourceId()) ?? null),
    onCastDialog: (listener) =>
      Effect.sync(() => {
        const subscription = onCastDialog(listener);

        return () => subscription.remove();
      }),
    onCastRoutes: (listener) =>
      Effect.sync(() => {
        const subscription = onCastRoutes(listener);

        return () => subscription.remove();
      }),
    showCastDialog: (browserId) => nativeCall("media.cast.show", () => showCastDialog(browserId)).pipe(Effect.asVoid),
    closeCastDialog: (dialogId) => nativeCall("media.cast.close", () => closeCastDialog(dialogId)),
    watchCastRoutes: (profile) => nativeCall("media.cast.routes", () => watchCastRoutes(profile)),
    usePicker: () => nativeCall("media.picker", () => setDisplayMediaPicker(true)),
    setAutoPictureInPicture: (on) => nativeCall("media.autoPip", () => setAutoPictureInPicture(on)),
    tasks: () => nativeCall("media.tasks", () => listTasks()),
    killTask: (id) => nativeCall("media.kill", () => killTask(id)).pipe(Effect.asVoid),
  });
}

/** A native call, with its failure named. */
function nativeCall<A>(name: string, run: () => A | Promise<A>): Effect.Effect<A, MediaFailure> {
  return Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new MediaFailure({ operation: { name }, cause }),
  });
}

// MARK: The service

/** The media work, as the windows use it. */
export class MediaService extends Context.Service<
  MediaService,
  {
    /** Registers the app's listeners: the engine's cast dialogs and routes, and the page changes that end a request. */
    readonly start: Effect.Effect<void>;
    /** A page asks to share a screen. A request the tab was already waiting on is answered with nothing. */
    readonly requestDisplayMedia: (tabId: string, request: DisplayMediaRequest) => Effect.Effect<void>;
    /** Keeps the picker's list of screens fresh until the picker closes or its request is answered. */
    readonly watchSources: (tabId: string, requestId: string, onSources: (sources: DisplayMediaSource[]) => void) => Effect.Effect<void>;
    /** Stops the picker's list: the picker closed. */
    readonly stopSources: (tabId: string, requestId: string) => Effect.Effect<void>;
    /** Answers a request with a screen, or with nothing. A request that is gone, or that another replaced, is not answered. */
    readonly answerDisplayMedia: (tabId: string, requestId: string, sourceId: string | null) => Effect.Effect<void>;
    /** Answers a request with another tab. The answer is for the request that asked, and for no other. */
    readonly shareTab: (tabId: string, requestId: string, sharedTabId: string) => Effect.Effect<string | null>;
    /** Opens the cast dialog of a window's tab, or closes the one it has open. */
    readonly toggleCastPicker: (windowId: string) => Effect.Effect<void>;
    /** Closes the cast dialog a tab has open. */
    readonly closeCastPicker: (tabId: string) => Effect.Effect<void>;
    /** Lists what the engine is running, while the window is open. Two windows share one poll. */
    readonly watchTasks: (windowId: string, onTasks: (tasks: EngineTask[]) => void) => Effect.Effect<void>;
    /** Stops a window's listing: the last one to stop ends the poll. */
    readonly stopTasks: (windowId: string) => Effect.Effect<void>;
    /** Ends a task, and brings the open listings up to date. */
    readonly endTask: (id: number) => Effect.Effect<void>;
  }
>()("bay/MediaService") {
  static readonly layer = Layer.effect(
    MediaService,
    Effect.gen(function* () {
      const engine = yield* MediaEngine;
      const diagnostics = yield* Diagnostics;
      const appScope = yield* Scope.Scope;

      // A failure is reported where every other failure goes. The poll that keeps failing reports once.
      const report = (failure: MediaFailure): Effect.Effect<void> =>
        diagnostics.report({
          operation: failure.operation,
          message: failure.message,
          cause: failure.cause instanceof Error ? failure.cause : new Error(String(failure.cause)),
        });

      // MARK: The page's request to share a screen

      const pendingOf = (tabId: string): PendingDisplayMedia | undefined => {
        // SAFETY: every request the store holds was put there by requestDisplayMedia, with the page it was made on.
        return useMedia.getState().displayRequests[tabId] as PendingDisplayMedia | undefined;
      };

      // The request is taken off the list before it is answered: a second choice finds nothing to answer.
      const take = (tabId: string, requestId: string): boolean => {
        if (pendingOf(tabId)?.id !== requestId) return false;

        useMedia.setState((m) => {
          const displayRequests = { ...m.displayRequests };

          delete displayRequests[tabId];

          return { displayRequests };
        });

        return true;
      };

      // The pickers that are open, by tab: the request each one shows, and the poll that keeps its list fresh.
      const pickers = new Map<string, { readonly requestId: string; readonly poll: Fiber.Fiber<void> }>();

      const stopSources = (tabId: string, requestId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const picker = pickers.get(tabId);

          if (!picker || picker.requestId !== requestId) return;

          pickers.delete(tabId);

          yield* Fiber.interrupt(picker.poll);
        });

      const resolveRequest = (tabId: string, requestId: string, sourceId: string | null): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* stopSources(tabId, requestId);
          yield* engine.resolveDisplayMedia(tabId, requestId, sourceId).pipe(Effect.catch(report));
        });

      const answer = (tabId: string, requestId: string, sourceId: string | null): Effect.Effect<void> =>
        Effect.suspend(() => (take(tabId, requestId) ? resolveRequest(tabId, requestId, sourceId) : Effect.void));

      const requestDisplayMedia = (tabId: string, request: DisplayMediaRequest): Effect.Effect<void> =>
        Effect.gen(function* () {
          const pending = pendingOf(tabId);
          const pageUrl = useBrowser.getState().tabs[tabId]?.url ?? "";

          // Publish the replacement before waiting for native cleanup, so a newer request cannot be overwritten.
          useMedia.setState((m) => ({ displayRequests: { ...m.displayRequests, [tabId]: { ...request, pageUrl } } }));

          // The page is not left waiting for a choice that is gone.
          if (pending) yield* resolveRequest(tabId, pending.id, null);
        });

      const pollSources = (tabId: string, requestId: string, onSources: (sources: DisplayMediaSource[]) => void): Effect.Effect<void> =>
        Effect.gen(function* () {
          let reported = false;

          for (;;) {
            yield* Effect.sleep(Duration.millis(SHARE_SOURCES_REFRESH_MS));

            // The request was answered between two polls: there is no picker to tell.
            if (pendingOf(tabId)?.id !== requestId) return;

            const next = yield* engine.sources().pipe(
              Effect.catch((failure) => {
                if (reported) return Effect.succeed(null);

                reported = true;

                return report(failure).pipe(Effect.as(null));
              }),
            );

            if (next && pendingOf(tabId)?.id === requestId) onSources(next);
          }
        });

      const watchSources = (tabId: string, requestId: string, onSources: (sources: DisplayMediaSource[]) => void): Effect.Effect<void> =>
        Effect.gen(function* () {
          const open = pickers.get(tabId);

          // The picker that was open for an older request is closed first: two polls would ask the engine twice.
          if (open) yield* stopSources(tabId, open.requestId);

          if (pendingOf(tabId)?.id !== requestId) return;

          const poll = yield* Effect.forkIn(pollSources(tabId, requestId, onSources), appScope);

          pickers.set(tabId, { requestId, poll });
        });

      const shareTab = (tabId: string, requestId: string, sharedTabId: string): Effect.Effect<string | null> =>
        Effect.gen(function* () {
          if (pendingOf(tabId)?.id !== requestId) return null;

          // The capture id is read just before it is used: a renderer change replaces it.
          const source = yield* engine.captureSourceId(sharedTabId).pipe(Effect.catch((failure) => report(failure).pipe(Effect.as(null))));

          // A newer request replaced this one meanwhile, and was answered: this choice was for the old one.
          if (pendingOf(tabId)?.id !== requestId) return null;

          yield* answer(tabId, requestId, source);

          return source;
        });

      // A page that moves on takes its request with it: the picker was for the page that asked.
      const cancelOnNavigation = (): (() => void) => {
        const page = (url: string) => url.replace(/#.*$/, "");

        return useBrowser.subscribe((s, prev) => {
          if (s.tabs === prev.tabs) return;

          for (const [tabId, request] of Object.entries(useMedia.getState().displayRequests)) {
            const url = s.tabs[tabId]?.url;

            // SAFETY: every request the store holds carries the page it was made on (requestDisplayMedia).
            const pageUrl = (request as PendingDisplayMedia).pageUrl;

            if (url !== undefined && page(url) !== page(pageUrl)) void Effect.runFork(Effect.forkIn(answer(tabId, request.id, null), appScope));
          }
        });
      };

      // MARK: The cast dialog

      // The engine's cast dialogs: a dialog for a tab the app no longer shows is closed at once.
      const onDialog = (dialog: CastDialog): void => {
        const tabId = tabForBrowser(dialog.browserId);

        if (!tabId) {
          if (dialog.open) void Effect.runFork(Effect.forkIn(engine.closeCastDialog(dialog.id).pipe(Effect.catch(report)), appScope));

          return;
        }

        useCast.setState((c) => {
          const dialogs = { ...c.dialogs };

          if (dialog.open) dialogs[tabId] = dialog;
          else if (dialogs[tabId]?.id === dialog.id) delete dialogs[tabId];

          return { dialogs };
        });
      };

      const closeCastPicker = (tabId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const dialog = useCast.getState().dialogs[tabId];

          if (dialog) yield* engine.closeCastDialog(dialog.id).pipe(Effect.catch(report));
        });

      const toggleCastPicker = (windowId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const tabId = activeTabId(useBrowser.getState(), windowId);

          if (!tabId) return;

          if (useCast.getState().dialogs[tabId]) return yield* closeCastPicker(tabId);

          const browserId = browserIdOf(tabId);

          if (browserId) yield* engine.showCastDialog(browserId).pipe(Effect.catch(report));
        });

      // The profiles whose routes the engine watches: a profile is watched once, however many windows show it.
      const watched = new Set<string>();

      const watchProfiles = (s: BrowserState): void => {
        for (const id of s.windowOrder) {
          const profile = castProfile(s, id);

          if (watched.has(profile)) continue;

          watched.add(profile);

          void Effect.runFork(Effect.forkIn(engine.watchCastRoutes(profile).pipe(Effect.catch(report)), appScope));
        }
      };

      // MARK: Starting

      let started = false;

      const start = Effect.gen(function* () {
        if (started) return;

        started = true;

        yield* engine.usePicker().pipe(Effect.catch(report));

        // Chrome's automatic Picture in Picture (a call's own window on a tab switch) goes with the app's setting.
        let autoPip: boolean | null = null;

        const syncAutoPip = () => {
          const on = useBrowser.getState().settings.autoPictureInPicture ?? true;

          if (on === autoPip) return;

          autoPip = on;

          void Effect.runFork(Effect.forkIn(engine.setAutoPictureInPicture(on).pipe(Effect.catch(report)), appScope));
        };

        syncAutoPip();

        const stopAutoPip = useBrowser.subscribe(syncAutoPip);
        const stopNavigation = cancelOnNavigation();
        const removeDialogs = yield* engine.onCastDialog(onDialog);
        const removeRoutes = yield* engine.onCastRoutes(({ profile, routes }) => useCast.setState((c) => ({ routes: { ...c.routes, [profile]: routes } })));

        watchProfiles(useBrowser.getState());

        const stopProfiles = useBrowser.subscribe((s, prev) => {
          if (s.windowOrder !== prev.windowOrder) watchProfiles(s);
        });

        // The app's scope owns the listeners: they are given back once, when it closes.
        yield* Scope.addFinalizer(
          appScope,
          Effect.sync(() => {
            stopAutoPip();
            stopNavigation();
            removeDialogs();
            removeRoutes();
            stopProfiles();
            started = false;
          }),
        );
      });

      // MARK: The engine's tasks

      // The windows that list the engine's tasks.
      const taskWindows = new Map<string, (tasks: EngineTask[]) => void>();

      // The one poll that feeds them: two task managers do not ask the engine twice.
      let taskPoll: Fiber.Fiber<void> | undefined;

      const tell = (tasks: EngineTask[]) => {
        for (const onTasks of taskWindows.values()) onTasks(tasks);
      };

      const pollTasks = Effect.gen(function* () {
        let reported = false;

        for (;;) {
          const tasks = yield* engine.tasks().pipe(
            Effect.catch((failure) => {
              if (reported) return Effect.succeed(null);

              reported = true;

              return report(failure).pipe(Effect.as(null));
            }),
          );

          if (tasks) tell(tasks);

          yield* Effect.sleep(Duration.millis(TASK_POLL_MS));
        }
      });

      const watchTasks = (windowId: string, onTasks: (tasks: EngineTask[]) => void): Effect.Effect<void> =>
        Effect.gen(function* () {
          taskWindows.set(windowId, onTasks);

          // The poll runs while a window is open, and only then.
          if (!taskPoll) taskPoll = yield* Effect.forkIn(pollTasks, appScope);
        });

      const stopTasks = (windowId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (!taskWindows.delete(windowId) || taskWindows.size > 0) return;

          // The last window closed: the engine is not asked any more.
          const poll = taskPoll;

          taskPoll = undefined;

          if (poll) yield* Fiber.interrupt(poll);
        });

      const endTask = (id: number): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* engine.killTask(id).pipe(Effect.catch(report));

          // The task is gone, and the open windows show it at once.
          const tasks = yield* engine.tasks().pipe(Effect.catch(() => Effect.succeed(null)));

          if (tasks) tell(tasks);
        });

      return MediaService.of({
        start,
        requestDisplayMedia,
        watchSources,
        stopSources,
        answerDisplayMedia: answer,
        shareTab,
        toggleCastPicker,
        closeCastPicker,
        watchTasks,
        stopTasks,
        endTask,
      });
    }),
  );
}

/** What the media work can do. */
export type Media = MediaService["Service"];
