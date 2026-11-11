// The app's extensions: what the engine has installed, the events it reports, and the commands the app sends it.
//
// The workflow is the service's: the snapshot is acquired once per profile, the engine's report is listened to
// once, and a failure is reported where every other failure goes. What the app does with an event stays plain:
// the store is written at once, the permission prompt is the user's to answer, and the side panels are placed by
// the windows.
import * as chromium from "@bay/chromium";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import type { Operation } from "../../effect/errors";
import { Diagnostics } from "../../effect/ports/diagnostics";
import { useBrowser, type BrowserState } from "../../store/browserStore";
import { applyExtensionSearchEngines } from "./searchEngines";
import { extensionProfile, useExtensions } from "./store";

// The engine registers a new extension's search engine a moment after the install: the first reconciliation of a
// profile waits for that, the later ones do not.
const FIRST_RECONCILE_DELAY = Duration.millis(3000);
const RECONCILE_DELAY = Duration.millis(400);

/** The extensions could not be read, changed or installed. */
export class ExtensionFailure extends TaggedError("ExtensionFailure")<{
  readonly operation: Operation;
  readonly message: string;
  readonly cause: unknown;
}> {}

/** What the app may change about an extension. */
export type ExtensionSettings = {
  pinned?: boolean;
  incognito?: boolean;
  fileAccess?: boolean;
  siteAccess?: "allSites" | "specificSites" | "onClick";
};

/** What the app changes about an extension. */
export type ExtensionUpdate = ExtensionSettings & {
  /** Whether the extension is on or off. */
  readonly enabled?: boolean;
};

/** The engine's extensions, as the app reaches them. */
export class ExtensionsEngine extends Context.Service<
  ExtensionsEngine,
  {
    /** The extensions a profile has installed. */
    readonly list: (profile: string) => Effect.Effect<chromium.InstalledExtension[], ExtensionFailure>;
    /** Installs an unpacked extension into a profile, and says which one it was. */
    readonly install: (path: string, profile: string) => Effect.Effect<string, ExtensionFailure>;
    /** Removes an extension from a profile. */
    readonly uninstall: (id: string, profile: string) => Effect.Effect<void, ExtensionFailure>;
    /** Turns an extension on or off. */
    readonly setEnabled: (id: string, profile: string, enabled: boolean) => Effect.Effect<void, ExtensionFailure>;
    /** Changes what an extension may do. */
    readonly configure: (id: string, profile: string, options: ExtensionSettings) => Effect.Effect<void, ExtensionFailure>;
    /** The search engines the extensions of a profile have registered. */
    readonly searchEngines: (profile: string) => Effect.Effect<chromium.EngineSearchEngineList, ExtensionFailure>;
    /** Answers the engine's question about an extension's permissions. */
    readonly resolvePrompt: (requestId: string, accepted: boolean) => Effect.Effect<void, ExtensionFailure>;
    /** The engine's report that a profile's extensions changed. The answer gives the report back. */
    readonly onChanged: (listener: (change: chromium.ExtensionsChange) => void) => Effect.Effect<() => void>;
  }
>()("bay/ExtensionsEngine") {
  static readonly layer = Layer.succeed(ExtensionsEngine)({
    list: (profile) =>
      Effect.tryPromise({
        try: () => chromium.listExtensions(profile),
        catch: (cause) =>
          new ExtensionFailure({ operation: { name: "extensions.list", resource: profile }, message: "The extensions could not be read.", cause }),
      }),
    install: (path, profile) =>
      Effect.tryPromise({
        try: () => chromium.installExtension({ path }, profile),
        catch: (cause) =>
          new ExtensionFailure({ operation: { name: "extensions.install", resource: profile }, message: "The extension could not be installed.", cause }),
      }),
    uninstall: (id, profile) =>
      Effect.tryPromise({
        try: () => chromium.uninstallExtension(id, profile),
        catch: (cause) =>
          new ExtensionFailure({ operation: { name: "extensions.uninstall", resource: profile }, message: "The extension could not be removed.", cause }),
      }),
    setEnabled: (id, profile, enabled) =>
      Effect.tryPromise({
        try: () => chromium.setExtensionEnabled(id, profile, enabled),
        catch: (cause) =>
          new ExtensionFailure({
            operation: { name: "extensions.enabled", resource: profile },
            message: "The extension could not be turned on or off.",
            cause,
          }),
      }),
    configure: (id, profile, options) =>
      Effect.tryPromise({
        try: () => chromium.configureExtension(id, profile, options),
        catch: (cause) =>
          new ExtensionFailure({
            operation: { name: "extensions.configure", resource: profile },
            message: "The extension's settings could not be changed.",
            cause,
          }),
      }),
    searchEngines: (profile) =>
      Effect.tryPromise({
        try: () => chromium.searchEngineList(profile),
        catch: (cause) =>
          new ExtensionFailure({
            operation: { name: "extensions.searchEngines", resource: profile },
            message: "The extension's search engines could not be read.",
            cause,
          }),
      }),
    resolvePrompt: (requestId, accepted) =>
      Effect.tryPromise({
        try: () => chromium.resolveExtensionInstallPrompt(requestId, accepted),
        catch: (cause) =>
          new ExtensionFailure({
            operation: { name: "extensions.prompt", resource: requestId },
            message: "The extension's request could not be answered.",
            cause,
          }),
      }),
    onChanged: (listener) =>
      Effect.sync(() => {
        const subscription = chromium.onExtensionsChanged(listener);

        return () => subscription.remove();
      }),
  });
}

/** What the service is asked for: a profile's extensions are read again. */
type ExtensionRequest = {
  readonly profile: string;
  /** Whether the engine said the profile's extensions changed. */
  readonly changed: boolean;
};

export class ExtensionsService extends Context.Service<
  ExtensionsService,
  {
    /** Starts the service: the engine's report is listened to, and the open profiles are read. */
    readonly start: Effect.Effect<void>;
    /** Stops the service, and gives every registration back. */
    readonly stop: Effect.Effect<void>;
    /** Reads a profile's extensions from the engine, and shows them. */
    readonly refresh: (profile: string) => Effect.Effect<void>;
    /** Installs an unpacked extension into a profile. */
    readonly install: (path: string, profile: string) => Effect.Effect<void, ExtensionFailure>;
    /** Turns an extension on or off, pins it, or changes what it may do. */
    readonly update: (id: string, profile: string, options: ExtensionUpdate) => Effect.Effect<void, ExtensionFailure>;
    /** Removes an extension from a profile. */
    readonly uninstall: (id: string, profile: string) => Effect.Effect<void, ExtensionFailure>;
    /** Answers the engine's question about an extension's permissions. */
    readonly answer: (requestId: string, accepted: boolean) => Effect.Effect<void>;
  }
>()("bay/ExtensionsService") {
  static readonly layer = Layer.effect(
    ExtensionsService,
    Effect.gen(function* () {
      const engine = yield* ExtensionsEngine;
      const diagnostics = yield* Diagnostics;
      const scope = yield* Scope.Scope;

      // The reads the app asks for, in the order they arrived.
      const requests = yield* Queue.unbounded<ExtensionRequest>();

      // The registrations the service holds, and the stop that gives them back.
      let release: (() => void) | undefined;

      // The profiles the app has read, and the profiles whose search engines have been reconciled.
      const read = new Set<string>();
      const reconciled = new Set<string>();

      // The reconciliation that is waiting for a profile: a change that arrives while one waits is folded into it,
      // so a profile is reconciled once for the changes it saw.
      const waiting = new Set<string>();

      // The engine's questions about an extension's permissions, and the answers they were given.
      const answered = new Set<string>();

      // A failure is reported once, where every other failure goes. An interruption is the expected end of
      // cancelled work, and stays silent.
      const report = (operation: Operation, cause: Cause.Cause<unknown>): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (Cause.hasInterruptsOnly(cause)) return;

          const squashed = Cause.squash(cause);
          const error = squashed instanceof Error ? squashed : new Error(String(squashed));

          yield* diagnostics.report({ operation, message: error.message, cause: error });
        });

      // A defect is a failure the app did not expect: it goes the same way.
      const reportDefect = (operation: Operation, cause: unknown): Effect.Effect<void> => {
        const error = cause instanceof Error ? cause : new Error(String(cause));

        return diagnostics.report({ operation, message: error.message, cause: error });
      };

      // Whether the profile's extensions are the ones it had: the engine's answer is what the app shows.
      const sameExtensions = (previous: chromium.InstalledExtension[] | undefined, list: chromium.InstalledExtension[]): boolean => {
        if (!previous || previous.length !== list.length) return false;

        return list.every((ext, at) => {
          const before = previous[at];

          return !!before && before.id === ext.id && before.enabled === ext.enabled;
        });
      };

      // The search engines the profile's extensions have registered, as the app keeps them.
      const reconcile = (profile: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const listed = yield* Effect.exit(engine.searchEngines(profile));

          // The engine could not be asked: the search engines stay as they were, and the failure is reported once.
          if (Exit.isFailure(listed)) {
            yield* report({ name: "extensions.searchEngines", resource: profile }, listed.cause);

            return;
          }

          reconciled.add(profile);
          applyExtensionSearchEngines(profile, listed.value);
        });

      // The reconciliation that is waiting for a profile.
      const schedule = (profile: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          // A reconciliation is already waiting: it reads the profile's engines when it runs, so it covers this
          // change too.
          if (waiting.has(profile)) return;

          waiting.add(profile);

          const delay = reconciled.has(profile) ? RECONCILE_DELAY : FIRST_RECONCILE_DELAY;

          // The reconciliation runs in the app's scope: it stops when the app does.
          yield* Effect.forkIn(
            Effect.gen(function* () {
              yield* Effect.sleep(delay);
              waiting.delete(profile);

              yield* reconcile(profile);
            }).pipe(
              // A reconciliation that is cut short leaves the profile ready for the next one.
              Effect.ensuring(Effect.sync(() => waiting.delete(profile))),
              Effect.catchDefect((defect) => reportDefect({ name: "extensions.searchEngines", resource: profile }, defect)),
            ),
            scope,
          );
        });

      // The profile's extensions, as the app shows them.
      const refresh = (profile: string, changed: boolean): Effect.Effect<void> =>
        Effect.gen(function* () {
          const listed = yield* Effect.exit(engine.list(profile));

          // The engine could not be asked: the list stays as it was, and the failure is reported once. Nothing asks
          // again on its own: the next change or the next command reads the profile again.
          if (Exit.isFailure(listed)) {
            yield* report({ name: "extensions.list", resource: profile }, listed.cause);

            return;
          }

          const list = [...listed.value].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
          const previous = useExtensions.getState().lists[profile];

          // The list is shown as it is: the store is written at once.
          useExtensions.setState((e) => ({ lists: { ...e.lists, [profile]: list } }));

          // The engine registers a new extension's search engine itself: the search engines are reconciled when the
          // extensions change, and when the engine says they did.
          if (changed || !sameExtensions(previous, list)) yield* schedule(profile);
        });

      // The commands the app sends the engine. The failure is named, and the caller decides what to show.
      const install = (path: string, profile: string): Effect.Effect<void, ExtensionFailure> =>
        Effect.gen(function* () {
          yield* engine.install(path, profile);
          yield* refresh(profile, false);
        });

      const uninstall = (id: string, profile: string): Effect.Effect<void, ExtensionFailure> =>
        Effect.gen(function* () {
          yield* engine.uninstall(id, profile);
          yield* refresh(profile, false);
        });

      const update = (id: string, profile: string, options: ExtensionUpdate): Effect.Effect<void, ExtensionFailure> =>
        Effect.gen(function* () {
          if (options.enabled !== undefined) yield* engine.setEnabled(id, profile, options.enabled);

          const settings = settingsOf(options);

          if (Object.keys(settings).length) yield* engine.configure(id, profile, settings);

          yield* refresh(profile, false);
        });

      // The engine's question about an extension's permissions. A question that was answered is not answered
      // again: the user said no once, and the app does not ask twice.
      const answer = (requestId: string, accepted: boolean): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (answered.has(requestId)) return;

          answered.add(requestId);

          const resolved = yield* Effect.exit(engine.resolvePrompt(requestId, accepted));

          if (Exit.isFailure(resolved)) yield* report({ name: "extensions.prompt", resource: requestId }, resolved.cause);
        });

      // The profiles the app reads: the ones the open windows show.
      const loadProfiles = (s: BrowserState): void => {
        for (const id of s.windowOrder) {
          const profile = extensionProfile(s, id);

          if (read.has(profile)) continue;

          read.add(profile);
          Queue.offerUnsafe(requests, { profile, changed: false });
        }
      };

      // The reads the service does in the background. They run in the app's scope: a read stops when the app does.
      // A read that fails is reported, and the next one still comes.
      const reads = Effect.forever(
        Effect.flatMap(Queue.take(requests), (request) =>
          refresh(request.profile, request.changed).pipe(
            Effect.catchDefect((defect) => reportDefect({ name: "extensions.list", resource: request.profile }, defect)),
          ),
        ),
      );

      const start = Effect.gen(function* () {
        // The service listens once: a second start does not listen twice.
        if (release) return;

        read.clear();
        reconciled.clear();

        const events = yield* engine.onChanged((change) => {
          Queue.offerUnsafe(requests, { profile: change.profile, changed: true });
        });

        const windows = useBrowser.subscribe((s, prev) => {
          if (s.windows !== prev.windows) loadProfiles(s);
        });

        release = () => {
          events();
          windows();
          release = undefined;
        };

        // The app's scope owns the listener and the subscription: it gives them back when it closes.
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => release?.()),
        );

        // The reads start with the service, and wait on the app's own clock.
        yield* Effect.forkIn(reads, scope);

        loadProfiles(useBrowser.getState());
      });

      const stop = Effect.sync(() => {
        release?.();
        release = undefined;
      });

      return ExtensionsService.of({
        start,
        stop,
        refresh: (profile) => refresh(profile, false),
        install,
        update,
        uninstall,
        answer,
      });
    }),
  );
}

/** What the app changes about an extension, as the engine takes it: only what is there is sent. */
const settingsOf = (options: ExtensionUpdate): ExtensionSettings => {
  const settings: ExtensionSettings = {};

  if (options.pinned !== undefined) settings.pinned = options.pinned;

  if (options.incognito !== undefined) settings.incognito = options.incognito;

  if (options.fileAccess !== undefined) settings.fileAccess = options.fileAccess;

  if (options.siteAccess !== undefined) settings.siteAccess = options.siteAccess;

  return settings;
};

/** What the app can do with the extensions. */
export type Extensions = ExtensionsService["Service"];
