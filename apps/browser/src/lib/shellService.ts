// The native shell: the commands the menu runs, the windows and downloads the Mac reports, and the menus the app's
// state describes.
//
// The listeners are the app's: each one is registered once, in the app's scope, and given back when that scope
// closes. What they change is the app's own, and it changes at once — a focus, an appearance, a window's title,
// the menu's state — so the chrome never shows what the app has already changed. The work the Mac answers later
// (which windows exist, whether the Mac is dark) runs in the background, and a failure there is reported once
// instead of being tried again and again.
import * as chromium from "@bay/chromium";
import * as desktop from "@bay/desktop";
import { capabilities, isMac } from "@bay/platform";
import { useCalendar } from "../activity/calendarService";
import { useExtensions } from "../components/extensions/store";
import { isUtilityWindowId } from "../components/settings/windows";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { Operation } from "../effect/errors";
import { AuthorityStore } from "../effect/ports/store";
import { Diagnostics } from "../effect/ports/diagnostics";
import { Scheduler } from "../effect/ports/scheduler";
import type { BrowserState } from "../store/browserStore";
import { engineProfile, incognitoSpaceId, windowTitle } from "../store/model";
import { nativeWindowPlacement } from "../store/windowPlacement";
import { isQuitting } from "./quit";
import { subscribeMenuInputs } from "./menuUpdates";
import { createNativeWindowReconciler } from "./nativeWindows";
import { startWindowPlacementSync } from "./windowPlacementSync";

/** How long the menu waits for the app to settle before it is rebuilt. */
const MENU_DEBOUNCE_MS = 120;

/** How often the menu is rebuilt while the calendar has events (the Join Meeting entry comes and goes with it). */
const MENU_REFRESH_MS = 30_000;

/** The Mac's appearance: what the app asks for. */
export type AppearanceMode = "auto" | "light" | "dark";

/** The bookmark menus the Mac has: the app caches them per bookmarks tree, so they are compared by identity. */
type BookmarkMenus =
  | desktop.MenuState["bookmarkFolders"]
  | desktop.MenuState["recentBookmarks"]
  | desktop.MenuState["bookmarksBar"]
  | desktop.MenuState["otherBookmarks"];

/** The native shell could not do what was asked. */
export class ShellFailure extends TaggedError("ShellFailure")<{
  readonly operation: Operation;
  readonly message: string;
  readonly cause: unknown;
}> {}

/** The native shell, as the app reaches it. */
export class ShellEngine extends Context.Service<
  ShellEngine,
  {
    /** Registers the one handler for the commands the menu runs. The answer gives the handler back. */
    readonly onCommand: (listener: (event: desktop.CommandEvent) => void) => Effect.Effect<() => void>;
    /** Registers the one handler for the windows the Mac reports. */
    readonly onWindowEvent: (listener: (event: desktop.WindowEvent) => void) => Effect.Effect<() => void>;
    /** Registers the one handler for the app's own events: its appearance, quitting, reopening. */
    readonly onAppEvent: (listener: (event: desktop.AppEvent) => void) => Effect.Effect<() => void>;
    /** Registers the one handler for the URLs another app asks to open. */
    readonly onOpenURLs: (listener: (urls: string[], sourceApp?: string) => void) => Effect.Effect<() => void>;
    /** Registers the one handler for the downloads the engine reports. */
    readonly onDownload: (listener: (download: chromium.Download) => void) => Effect.Effect<() => void>;
    /** The windows the Mac has open. */
    readonly windowIds: () => Effect.Effect<string[], ShellFailure>;
    /** Whether the Mac is in dark mode. */
    readonly isDarkAppearance: () => Effect.Effect<boolean, ShellFailure>;
    /** The Mac's appearance. */
    readonly setAppearance: (mode: AppearanceMode) => Effect.Effect<void, ShellFailure>;
    /** Opens a window. */
    readonly openWindow: (id: string, options: desktop.OpenWindowOptions) => Effect.Effect<void, ShellFailure>;
    /** Closes a window. */
    readonly closeWindow: (id: string) => Effect.Effect<void, ShellFailure>;
    /** Brings a window to the front. */
    readonly focusWindow: (id: string) => Effect.Effect<void, ShellFailure>;
    /** Gives a window its title. */
    readonly setWindowTitle: (id: string, title: string) => Effect.Effect<void, ShellFailure>;
    /** Gives the Mac the menu's state. The bookmark lists only go with it when they changed. */
    readonly setMenuState: (state: desktop.MenuState, bookmarksChanged: boolean) => Effect.Effect<void, ShellFailure>;
    /** Frees an incognito profile's engine data. */
    readonly releaseProfile: (profile: string) => Effect.Effect<void, ShellFailure>;
  }
>()("bay/ShellEngine") {
  static readonly layer = Layer.succeed(ShellEngine)({
    onCommand: (listener) =>
      Effect.sync(() => {
        const subscription = desktop.onCommand(listener);

        return () => subscription.remove();
      }),
    onWindowEvent: (listener) =>
      Effect.sync(() => {
        const subscription = desktop.onWindowEvent(listener);

        return () => subscription.remove();
      }),
    onAppEvent: (listener) =>
      Effect.sync(() => {
        const subscription = desktop.onAppEvent(listener);

        return () => subscription.remove();
      }),
    onOpenURLs: (listener) =>
      Effect.sync(() => {
        const subscription = desktop.onOpenURLs(listener);

        return () => subscription.remove();
      }),
    onDownload: (listener) =>
      Effect.sync(() => {
        const subscription = chromium.onDownload(listener);

        return () => subscription.remove();
      }),
    windowIds: () =>
      Effect.tryPromise({
        try: () => desktop.windowIds(),
        catch: (cause) =>
          new ShellFailure({
            operation: { name: "shell.windowIds" },
            message: "The system's open windows could not be read.",
            cause,
          }),
      }),
    isDarkAppearance: () =>
      Effect.tryPromise({
        try: () => desktop.isDarkAppearance(),
        catch: (cause) =>
          new ShellFailure({
            operation: { name: "shell.isDarkAppearance" },
            message: "The system's appearance could not be read.",
            cause,
          }),
      }),
    setAppearance: (mode) =>
      Effect.tryPromise({
        try: () => desktop.setAppearance(mode),
        catch: (cause) =>
          new ShellFailure({
            operation: { name: "shell.setAppearance" },
            message: "The system's appearance could not be set.",
            cause,
          }),
      }),
    openWindow: (id, options) =>
      Effect.tryPromise({
        try: () => desktop.openWindow(id, options),
        catch: (cause) =>
          new ShellFailure({
            operation: { name: "shell.openWindow", resource: id },
            message: "The window could not be opened.",
            cause,
          }),
      }),
    closeWindow: (id) =>
      Effect.tryPromise({
        try: () => desktop.closeWindow(id),
        catch: (cause) =>
          new ShellFailure({
            operation: { name: "shell.closeWindow", resource: id },
            message: "The window could not be closed.",
            cause,
          }),
      }),
    focusWindow: (id) =>
      Effect.tryPromise({
        try: () => desktop.focusWindow(id),
        catch: (cause) =>
          new ShellFailure({
            operation: { name: "shell.focusWindow", resource: id },
            message: "The window could not be brought to the front.",
            cause,
          }),
      }),
    setWindowTitle: (id, title) =>
      Effect.tryPromise({
        try: () => desktop.setWindowTitle(id, title),
        catch: (cause) =>
          new ShellFailure({
            operation: { name: "shell.setWindowTitle", resource: id },
            message: "The window's title could not be set.",
            cause,
          }),
      }),
    setMenuState: (state, bookmarksChanged) =>
      Effect.tryPromise({
        try: () => desktop.setMenuStateParts(state, bookmarksChanged),
        catch: (cause) =>
          new ShellFailure({
            operation: { name: "shell.setMenuState" },
            message: "The menu's state could not be sent to the system.",
            cause,
          }),
      }),
    releaseProfile: (profile) =>
      Effect.tryPromise({
        try: () => chromium.releaseProfile(profile),
        catch: (cause) =>
          new ShellFailure({
            operation: { name: "shell.releaseProfile", resource: profile },
            message: "The incognito profile's engine data could not be freed.",
            cause,
          }),
      }),
  });
}

/** What the app does with the shell's events. */
export type ShellHandlers = {
  /** The command the menu ran. Without one, the shell leaves the commands to the documents that run them. */
  readonly command?: (event: desktop.CommandEvent) => void;
  /** The app's own event: the warning it showed, quitting, reopening. The appearance the Mac reports is the shell's. */
  readonly appEvent: (event: desktop.AppEvent) => void;
  /** The URLs another app asked to open. */
  readonly openURLs: (urls: string[], sourceApp?: string) => void;
  /** The menu's state, as the app's state describes it. */
  readonly menu: (state: BrowserState) => desktop.MenuState;
};

/** How the shell follows the app's windows. */
export type ShellOptions = {
  /**
   * The shared host's coordinator: its windows follow the states the coordinator accepts (reconcile), not every change
   * to the store, and the windows the host already has are its own (the coordinator's document among them).
   */
  readonly shared?: boolean;
};

export class ShellService extends Context.Service<
  ShellService,
  {
    /** Starts the shell: the listeners are registered and the native chrome is kept in step with the app. */
    readonly start: (handlers: ShellHandlers, options?: ShellOptions) => Effect.Effect<void>;
    /** Gives the shell's listeners back. */
    readonly stop: Effect.Effect<void>;
    /** Brings the native windows in step with an accepted state, and waits for the Mac to answer. */
    readonly reconcile: (state: BrowserState) => Effect.Effect<void>;
  }
>()("bay/ShellService") {
  static readonly layer = Layer.effect(
    ShellService,
    Effect.gen(function* () {
      const browser = yield* AuthorityStore;
      const engine = yield* ShellEngine;
      const diagnostics = yield* Diagnostics;
      const scheduler = yield* Scheduler;
      const scope = yield* Scope.Scope;

      // The windows the app wants, as the Mac has acknowledged them: an open that fails takes the window out of the
      // app, and one that finishes after the window went is closed again (nativeWindows.ts). A started shell has one.
      let windows: ReturnType<typeof createNativeWindowReconciler<desktop.OpenWindowOptions>> | undefined;

      // The size and the maximized state a window has on a host that places it itself (windowPlacementSync.ts).
      let placement: ReturnType<typeof startWindowPlacementSync> | undefined;

      // Whether the Mac has reported its appearance: the report wins over the answer to the first question.
      let appearanceHeard = false;

      // The menu's state as the Mac has it, so the same state is not sent twice.
      let lastMenu = "";
      let lastBookmarkMenus: BookmarkMenus[] = [];

      // The menu's update that is waiting for the app to settle.
      let menuPending = false;

      // The listeners and the subscriptions the shell holds, and the stop that gives them all back.
      let removals: (() => void)[] = [];

      // A branch of the shell's work: it starts at once, it runs in the app's scope, and it is interrupted when
      // that scope closes.
      const branch = (work: Effect.Effect<void>): void => {
        void Effect.runFork(Effect.forkIn(work, scope, { startImmediately: true }));
      };

      // The failure behind a native call, as an error the diagnostics can carry.
      const asError = (cause: unknown): Error => (cause instanceof Error ? cause : new Error(String(cause)));

      // A failure is reported once, where every other failure goes.
      const report = (failure: ShellFailure): Effect.Effect<void> =>
        diagnostics.report({ operation: failure.operation, message: failure.message, cause: asError(failure.cause) });

      // A defect is the app's own mistake, and it goes where every other failure goes: it must not take the shell
      // with it.
      const reportDefect = (cause: unknown): Effect.Effect<void> =>
        diagnostics.report({
          operation: { name: "shell" },
          message: "The native shell failed unexpectedly.",
          cause: asError(cause),
        });

      // The native call goes out now: the window's first frame waits for it, and only its answer comes later. A
      // failure is reported and the shell carries on.
      const supervise = (work: Effect.Effect<void, ShellFailure>): void => {
        branch(
          work.pipe(
            Effect.catch((failure) => report(failure)),
            Effect.catchDefect((cause) => reportDefect(cause)),
          ),
        );
      };

      // A native call as the window reconciler reaches it: it goes out now, in the app's scope, and its answer is the
      // promise's. A scope that closes first rejects it, so nothing waits for an answer that cannot come.
      const call = (work: Effect.Effect<void, ShellFailure>): Promise<void> =>
        new Promise((resolve, reject) => {
          branch(
            work.pipe(
              Effect.onExit((exit) => Effect.sync(() => (Exit.isSuccess(exit) ? resolve() : reject(Cause.squash(exit.cause))))),
              Effect.catchCause(() => Effect.void),
            ),
          );
        });

      // A window call that failed: the native failure is reported as it is, anything else as the app's mistake.
      const reportWindow = (error: Error): void => {
        branch(error instanceof ShellFailure ? report(error) : reportDefect(error));
      };

      const windowReconciler = () =>
        createNativeWindowReconciler<desktop.OpenWindowOptions>({
          open: async (id, options) => {
            await call(engine.openWindow(id, options));
            placement?.opened(id);
          },
          close: (id) => call(engine.closeWindow(id)),
          setTitle: (id, title) => call(engine.setWindowTitle(id, title)),
          focus: (id) => call(engine.focusWindow(id)),
          // A window the Mac could not open is not left in the app, where nothing would show it.
          openFailed: (id) => browser.getState().closeWindow(id),
          // An incognito window's engine data goes when it closes.
          closed: (id, options) => {
            if (options.incognito) supervise(engine.releaseProfile(incognitoSpaceId(id)));
          },
          report: (_operation, _id, error) => reportWindow(error),
        });

      // The windows the app has, as the Mac is told about them: the app opens and closes them, and the Mac
      // answers later.
      const syncWindows = (s: BrowserState, prev?: BrowserState): void => {
        if (
          !windows ||
          (prev &&
            s.tabs === prev.tabs &&
            s.tabLists === prev.tabLists &&
            s.windows === prev.windows &&
            s.spaces === prev.spaces &&
            s.ui.focusedWindowId === prev.ui.focusedWindowId)
        )
          return;

        // Open the focused window last so it comes to front.
        const focused = s.ui.focusedWindowId;
        const order = s.windowOrder.filter((id) => id !== focused);

        if (focused && s.windows[focused]) order.push(focused);

        windows.sync(
          order.map((id) => {
            const w = s.windows[id]!;
            const title = windowTitle(s, id);
            // A Mac window shows any profile's pages. A Chrome-hosted one is the Default profile's and keeps a Browser
            // for each other profile its spaces show, so a space switch never replaces the window.
            const profile = isMac || w.incognito ? engineProfile(w.spaceId) : "";
            const small = w.kind === "small" ? { kind: "small" as const, size: s.settings.littleBaySize } : {};

            return { id, title, options: { ...nativeWindowPlacement(w), incognito: w.incognito, title, focus: id === focused, profile, ...small } };
          }),
          focused,
        );
      };

      // The menu's state, as the Mac has it: the same state is not sent twice.
      const syncMenu = (handlers: ShellHandlers): void => {
        // Without a menu bar the menus are the window's own, and there is nothing to send.
        if (!capabilities.menuBar) return;
        const state = handlers.menu(browser.getState());
        // The bookmark menus are cached per bookmarks tree (bookmarkMenus), so they compare by identity;
        // stringifying them (thousands of bookmarks) on every store change is what this sync used to spend.
        const { bookmarkFolders, recentBookmarks, bookmarksBar, otherBookmarks, ...rest } = state;
        const bookmarkMenus = [bookmarkFolders, recentBookmarks, bookmarksBar, otherBookmarks];
        const json = JSON.stringify(rest);
        const bookmarksChanged = !bookmarkMenus.every((menu, i) => menu === lastBookmarkMenus[i]);

        if (json === lastMenu && !bookmarksChanged) return;
        lastMenu = json;
        lastBookmarkMenus = bookmarkMenus;
        supervise(engine.setMenuState(state, bookmarksChanged));
      };

      // The menu's updates are debounced: the store changes many times a second, and the native menus are built
      // from the state as it is when the dust settles.
      const scheduleMenu = (handlers: ShellHandlers): void => {
        if (menuPending) return;
        menuPending = true;

        branch(
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(MENU_DEBOUNCE_MS));

            // The flag goes before the menu is built: a change that comes while it is built waits for the next
            // one, as it did before.
            menuPending = false;
            syncMenu(handlers);
          }).pipe(Effect.catchDefect((cause) => reportDefect(cause))),
        );
      };

      // The Mac's appearance follows the app's: the setting is the app's, the Mac is told.
      const syncAppearance = (s: BrowserState, prev: BrowserState): void => {
        if (s.settings.appearance === prev.settings.appearance) return;
        supervise(engine.setAppearance(s.settings.appearance));
      };

      // The windows the Mac reports: a focus, a frame, a close. The app's own state changes at once.
      const onWindow = (event: desktop.WindowEvent): void => {
        const s = browser.getState();

        if (event.type === "focus") s.setFocusedWindow(event.id);

        if (event.type === "frame") s.setWindowFrame(event.id, event.frame);

        if (event.type === "close") {
          // The windows close as the app quits: the session keeps them.
          if (isQuitting()) return;
          windows?.nativeClosed(event.id);
          s.closeWindow(event.id);
        }
      };

      // The app's own events: the appearance the Mac reports is the shell's, the rest are the app's.
      const onApp =
        (handlers: ShellHandlers) =>
        (event: desktop.AppEvent): void => {
          if (event.type === "appearance") {
            appearanceHeard = true;
            browser.getState().setAppDark(event.dark);
          }

          handlers.appEvent(event);
        };

      // The Mac's own appearance: the app shows what the Mac is in, not what the setting says.
      const readAppearance = (): Effect.Effect<void, ShellFailure> =>
        Effect.gen(function* () {
          const dark = yield* engine.isDarkAppearance();

          // The Mac reported a change while it answered: the report is newer.
          yield* Effect.sync(() => {
            if (!appearanceHeard) browser.getState().setAppDark(dark);
          });
        });

      // The windows the Mac has: the ones the app doesn't know are closed, and the ones it knows are given their
      // title (a window that was already open kept the title it had).
      const reconcileWindows = (): Effect.Effect<void, ShellFailure> =>
        Effect.gen(function* () {
          const ids = yield* engine.windowIds();
          const s = browser.getState();

          for (const id of ids) {
            if (!s.windows[id]) {
              if (!isUtilityWindowId(id)) supervise(engine.closeWindow(id));
              continue;
            }

            supervise(engine.setWindowTitle(id, windowTitle(s, id)));
          }
        });

      // The listeners and the subscriptions are given back, once.
      const stopListening = (): void => {
        for (const remove of removals) remove();
        removals = [];
        windows?.dispose();
        windows = undefined;
        placement?.dispose();
        placement = undefined;
        appearanceHeard = false;

        // The menu the Mac has is the app's own now: a shell that starts again sends it again.
        lastMenu = "";
        lastBookmarkMenus = [];
        menuPending = false;
      };

      const start = (handlers: ShellHandlers, { shared = false }: ShellOptions = {}): Effect.Effect<void> =>
        Effect.gen(function* () {
          // The shell is started once: a second start would register the listeners twice.
          if (removals.length) return;

          // Before any window opens or is asked about: a placement the host reports wins over the answer to the
          // question asked once a window opened.
          placement = startWindowPlacementSync(browser.store);
          windows = windowReconciler();

          // One handler per event: the Mac's commands, its windows, the app's own events, the URLs another app
          // asks to open and the downloads the engine reports.
          removals = [
            ...(handlers.command ? [yield* engine.onCommand(handlers.command)] : []),
            yield* engine.onWindowEvent(onWindow),
            yield* engine.onAppEvent(onApp(handlers)),
            yield* engine.onOpenURLs(handlers.openURLs),
            yield* engine.onDownload((download) => browser.getState().upsertDownload(download)),
          ];

          // The app's own changes: the windows it has. The shared host's coordinator opens them as it accepts each
          // state instead (reconcile), so a private window's profile is reserved before the window asks for it.
          if (!shared) removals.push(browser.subscribe((s, prev) => syncWindows(s, prev)));

          // The Mac is told the appearance the app wants.
          removals.push(browser.subscribe((s, prev) => syncAppearance(s, prev)));

          // The menu's inputs: the app's state, the extensions and the calendar.
          if (capabilities.menuBar) {
            removals.push(subscribeMenuInputs(() => scheduleMenu(handlers)));
            removals.push(
              useExtensions.subscribe((e, prev) => {
                if (e.lists !== prev.lists) scheduleMenu(handlers);
              }),
            );
            removals.push(
              useCalendar.subscribe((c, prev) => {
                if (c.events !== prev.events) scheduleMenu(handlers);
              }),
            );
          }

          // The app's scope owns them all: it gives them back when it closes, once.
          yield* Scope.addFinalizer(scope, Effect.sync(stopListening));

          // Join Meeting (⌃⌘J) comes and goes with the calendar and the clock, not the store.
          if (capabilities.menuBar) {
            yield* scheduler.every({
              every: MENU_REFRESH_MS,
              needed: () => useCalendar.getState().events.length > 0,
              watch: (changed) => useCalendar.subscribe(changed),
              run: Effect.sync(() => scheduleMenu(handlers)),
            });
          }

          // The windows the app has open now: the Mac's answer about which windows exist comes later, and waiting
          // for it put 20–100 ms before the first frame.
          if (!shared) syncWindows(browser.getState());
          syncMenu(handlers);

          // The Mac is told the appearance the app wants; it answers with the one it is in.
          supervise(engine.setAppearance(browser.getState().settings.appearance));

          // The Mac's appearance and the windows it has: both come later. The shared host has windows of its own (the
          // coordinator's document among them), so it leaves them be.
          supervise(readAppearance());

          if (!shared) supervise(reconcileWindows());
        });

      const stop = Effect.sync(stopListening);

      // An accepted state that arrives outside the store's own changes (the coordinator's reconciliation) is applied
      // the same way the store's own changes are, and the coordinator waits for the Mac's answers before it goes on.
      const reconcile = (state: BrowserState): Effect.Effect<void> =>
        Effect.gen(function* () {
          const current = windows;

          if (!current) return;

          syncWindows(state);

          yield* Effect.promise(() => current.flush());
        });

      return ShellService.of({ start, stop, reconcile });
    }),
  );
}

/** What the native shell can do. */
export type Shell = ShellService["Service"];
