// The fakes a service test runs against: files in memory, a network that answers from a script, a clock the test
// moves by hand, diagnostics that keep what they were told, and a count of what is still held so a test can prove a
// service let go of everything it took.
import type { DownloadUpdate, MediaControl, Tab, TrackingParameters } from "@bay/engine";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { createTab, initialBrowserData, reduceBrowserData, type BrowserAction } from "../store/model.ts";
import type { BrowserData } from "../store/types.ts";
import { DecodeError } from "./errors.ts";
import { BrowserState } from "./ports/browserState.ts";
import { Diagnostics, type Diagnostic } from "./ports/diagnostics.ts";
import { Engine, PageScriptFailed } from "./ports/engine.ts";
import { Files, type FileRoot } from "./ports/files.ts";
import { Http, HttpError, type HttpRequest, type HttpResponse } from "./ports/http.ts";
import { Lifecycle, type AppStatus } from "./ports/lifecycle.ts";
import { Links } from "./ports/links.ts";
import { SecureStore } from "./ports/secureStore.ts";

/** The clock a test controls: time only moves when the test says so. */
export const testClockLayer = TestClock.layer();

/** Runs a program with the test clock in place. */
export const withTestClock = <A, E>(program: Effect.Effect<A, E, TestClock.TestClock>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(testClockLayer)));

/**
 * A count of what is still held, so a test can prove a service let go of everything it took.
 */
export class ResourceLedger {
  private readonly held = new Map<string, number>();

  /** Records that a resource was taken. */
  take(name: string): void {
    this.held.set(name, (this.held.get(name) ?? 0) + 1);
  }

  /** Records that a resource was given back. */
  give(name: string): void {
    const count = this.held.get(name);

    if (count === undefined) return;

    if (count <= 1) {
      this.held.delete(name);

      return;
    }

    this.held.set(name, count - 1);
  }

  /** The resources that are still held. */
  outstanding(): readonly string[] {
    return [...this.held.keys()];
  }

  /** How many resources are still held. */
  count(): number {
    let total = 0;

    for (const count of this.held.values()) total += count;

    return total;
  }
}

/** What the diagnostics were told. */
export type FakeDiagnostics = {
  readonly layer: Layer.Layer<Diagnostics>;
  readonly reports: readonly Diagnostic[];
  readonly warnings: readonly string[];
};

/** Diagnostics that keep what they were told instead of sending it anywhere. */
export const fakeDiagnostics = (): FakeDiagnostics => {
  const reports: Diagnostic[] = [];
  const warnings: string[] = [];

  return {
    layer: Layer.succeed(Diagnostics)({
      report: (diagnostic) => Effect.sync(() => void reports.push(diagnostic)),
      warn: (message) => Effect.sync(() => void warnings.push(message)),
    }),
    reports,
    warnings,
  };
};

/** The files a fake keeps. */
export type FakeFiles = {
  readonly layer: Layer.Layer<Files>;
  readonly files: Map<string, string>;
};

/** Files in memory: a read comes back what was written. */
export const fakeFiles = (): FakeFiles => {
  const files = new Map<string, string>();
  const key = (root: FileRoot, path: string) => `${root}/${path}`;

  return {
    layer: Layer.succeed(Files)({
      read: (root, path) => Effect.succeed(files.get(key(root, path)) ?? null),
      write: (root, path, contents) => Effect.sync(() => void files.set(key(root, path), contents)),
      exists: (root, path) => Effect.succeed(files.has(key(root, path))),
      delete: (root, path) => Effect.sync(() => void files.delete(key(root, path))),
      move: (root, from, to) =>
        Effect.sync(() => {
          const contents = files.get(key(root, from));

          if (contents === undefined) return;

          files.set(key(root, to), contents);
          files.delete(key(root, from));
        }),
      size: (root, path) => Effect.succeed(files.get(key(root, path))?.length ?? 0),
      // The fake has no digests: it answers with the number of characters.
      digest: (root, path) => Effect.succeed(String(files.get(key(root, path))?.length ?? 0)),
      download: (root, path, url) => Effect.sync(() => void files.set(key(root, path), url)),
      list: (root, path) =>
        Effect.sync(() => {
          const prefix = `${root}/${path}/`;
          const names: string[] = [];

          for (const entry of files.keys()) {
            if (entry.startsWith(prefix)) names.push(entry.slice(prefix.length));
          }

          return names;
        }),
      createDirectory: () => Effect.void,
    }),
    files,
  };
};

/** The requests a fake network was asked for. */
export type FakeHttp = {
  readonly layer: Layer.Layer<Http>;
  readonly requests: readonly HttpRequest[];
  /** Answers a request to `url` with `response`. */
  readonly answer: (url: string, response: HttpResponse) => void;
  /** Fails a request to `url` with `error`. */
  readonly fail: (url: string, error: Error) => void;
};

/** A network that answers from a script instead of the internet. */
export const fakeHttp = (): FakeHttp => {
  const requests: HttpRequest[] = [];
  const answers = new Map<string, HttpResponse | Error>();
  const noHeaders = { get: () => null };

  const send = (request: HttpRequest) =>
    Effect.suspend(() => {
      requests.push(request);
      const answer = answers.get(request.url);

      if (answer === undefined) {
        return Effect.fail(new HttpError({ operation: { name: "http.send", resource: request.url }, status: 404, cause: new Error("no answer") }));
      }

      if (answer instanceof Error) {
        return Effect.fail(new HttpError({ operation: { name: "http.send", resource: request.url }, status: 0, cause: answer }));
      }

      // A status that isn't a success is a failure, as the real network says it is.
      if (!answer.ok) {
        return Effect.fail(
          new HttpError({ operation: { name: "http.send", resource: request.url }, status: answer.status, cause: new Error(String(answer.status)) }),
        );
      }

      return Effect.succeed({ ...answer, headers: answer.headers ?? noHeaders });
    });

  return {
    layer: Layer.succeed(Http)({
      send,
      sendJson: (request, decode) =>
        send(request).pipe(
          Effect.flatMap((response) =>
            Effect.try({
              try: () => decode(response.body),
              catch: (cause) => new DecodeError({ operation: { name: "http.decode", resource: request.url }, cause }),
            }),
          ),
        ),
    }),
    requests,
    answer: (url, response) => void answers.set(url, response),
    fail: (url, error) => void answers.set(url, error),
  };
};

/** The secrets a fake keeps. */
export type FakeSecureStore = {
  readonly layer: Layer.Layer<SecureStore>;
  readonly values: Map<string, string>;
};

/** Secrets in memory: a read comes back what was written. */
export const fakeSecureStore = (): FakeSecureStore => {
  const values = new Map<string, string>();

  return {
    layer: Layer.succeed(SecureStore)({
      read: (key) => Effect.succeed(values.get(key) ?? null),
      write: (key, value) => Effect.sync(() => void values.set(key, value)),
      delete: (key) => Effect.sync(() => void values.delete(key)),
    }),
    values,
  };
};

/** What the app asked the engine to do. */
export type FakeEngine = {
  readonly layer: Layer.Layer<Engine>;
  readonly ledger: ResourceLedger;
  /** The scripts that were run. */
  readonly scripts: readonly string[];
  /** The answers the fake gives, by script. */
  readonly answers: Map<string, string>;
  /** How often the data was cleared. */
  readonly cleared: number;
  /** Whether a private session is open. */
  readonly privateSession: boolean;
  /** The snapshots that were kept. */
  readonly prunedSnapshots: readonly (readonly string[])[];
  /** The tab states that were kept. */
  readonly prunedTabStates: readonly (readonly string[])[];
  /** The filter lists that were applied. */
  readonly blocking: readonly { readonly files: readonly string[] | null; readonly version: string }[];
  /** The hosts where blocking was paused. */
  readonly pausedHosts: readonly (readonly string[])[];
  /** The downloads that were opened. */
  readonly openedDownloads: readonly string[];
  /** The downloads that were cancelled. */
  readonly cancelledDownloads: readonly string[];
  /** The images that were saved. */
  readonly savedImages: readonly string[];
  /** The download handlers the app registered. */
  readonly downloadHandlers: readonly ((update: DownloadUpdate) => void)[];
  /** The media control handlers the app registered. */
  readonly mediaHandlers: readonly ((action: MediaControl) => void)[];
  /** The share handlers the app registered. */
  readonly shareHandlers: readonly ((url: string) => void)[];
};

/** An engine that records what it was asked and answers with what the test wrote down. */
export const fakeEngine = (ledger: ResourceLedger = new ResourceLedger()): FakeEngine => {
  const scripts: string[] = [];
  const answers = new Map<string, string>();
  const prunedSnapshots: string[][] = [];
  const prunedTabStates: string[][] = [];
  const blocking: { files: readonly string[] | null; version: string }[] = [];
  const pausedHosts: string[][] = [];
  const openedDownloads: string[] = [];
  const cancelledDownloads: string[] = [];
  const savedImages: string[] = [];
  const downloadHandlers = new Set<(update: DownloadUpdate) => void>();
  const mediaHandlers = new Set<(action: MediaControl) => void>();
  const shareHandlers = new Set<(url: string) => void>();
  let cleared = 0;
  let privateSession = false;

  /** Registers a native listener, and gives it back when the scope closes. */
  const listen = <A>(name: string, handlers: Set<A>, handler: A, register: () => { remove(): void }) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;

      handlers.add(handler);
      ledger.take(name);

      const subscription = register();

      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          subscription.remove();
          handlers.delete(handler);
          ledger.give(name);
        }),
      );
    });

  return {
    layer: Layer.succeed(Engine)({
      runPageScript: <A>(tab: Tab, script: string) =>
        Effect.suspend(() => {
          scripts.push(script);

          return Effect.try({
            try: () => {
              const answer = answers.get(script);

              if (answer === undefined) throw new Error("The fake engine has no answer for this script.");

              // SAFETY: the test wrote the answer down as JSON text, so parsing it yields the caller's own type.
              return JSON.parse(answer) as A;
            },
            catch: (cause) => new PageScriptFailed({ operation: { name: "engine.pageScript" }, cause }),
          });
        }),
      snapshot: () => Effect.succeed(null),
      saveState: () => Effect.void,
      clearData: () =>
        Effect.sync(() => {
          cleared += 1;
        }),
      setPrivateSessionActive: (active) =>
        Effect.sync(() => {
          privateSession = active;
        }),
      pruneSnapshots: (keep) =>
        Effect.sync(() => {
          prunedSnapshots.push([...keep]);
        }),
      pruneTabStates: (keep) =>
        Effect.sync(() => {
          prunedTabStates.push([...keep]);
        }),
      setContentBlocking: (files, version) =>
        Effect.sync(() => {
          blocking.push({ files: files ? [...files] : null, version });
        }),
      setBlockingPausedHosts: (hosts) =>
        Effect.sync(() => {
          pausedHosts.push([...hosts]);
        }),
      setTrackingParameters: (_table: TrackingParameters) => Effect.void,
      openDownload: (reference) =>
        Effect.sync(() => {
          openedDownloads.push(reference);
        }),
      cancelDownload: (id) =>
        Effect.sync(() => {
          cancelledDownloads.push(id);
        }),
      saveImage: (url) =>
        Effect.sync(() => {
          savedImages.push(url);
        }),
      startListening: () => Effect.succeed(null),
      onDownload: (handler) =>
        listen("engine.download", downloadHandlers, handler, () => ({
          remove: () => undefined,
        })),
      onMediaControl: (handler) =>
        listen("engine.media", mediaHandlers, handler, () => ({
          remove: () => undefined,
        })),
      onShare: (handler) =>
        listen("engine.share", shareHandlers, handler, () => ({
          remove: () => undefined,
        })),
      takeShare: () => Effect.succeed(null),
    }),
    ledger,
    scripts,
    answers,
    get cleared() {
      return cleared;
    },
    get privateSession() {
      return privateSession;
    },
    prunedSnapshots,
    prunedTabStates,
    blocking,
    pausedHosts,
    openedDownloads,
    cancelledDownloads,
    savedImages,
    get downloadHandlers() {
      return [...downloadHandlers];
    },
    get mediaHandlers() {
      return [...mediaHandlers];
    },
    get shareHandlers() {
      return [...shareHandlers];
    },
  };
};

/** What the app asked about the app's state. */
export type FakeLifecycle = {
  readonly layer: Layer.Layer<Lifecycle>;
  readonly ledger: ResourceLedger;
  /** The handlers the app registered. */
  readonly handlers: readonly ((status: AppStatus) => void)[];
  /** Sends a status to the app, as the system would. */
  readonly emit: (status: AppStatus) => void;
};

/** An app state that keeps the handlers and calls them when the test says so. */
export const fakeLifecycle = (ledger: ResourceLedger = new ResourceLedger()): FakeLifecycle => {
  const handlers = new Set<(status: AppStatus) => void>();

  return {
    layer: Layer.succeed(Lifecycle)({
      onChange: (handler) =>
        Effect.gen(function* () {
          const scope = yield* Scope.Scope;

          handlers.add(handler);
          ledger.take("lifecycle");

          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              handlers.delete(handler);
              ledger.give("lifecycle");
            }),
          );
        }),
    }),
    ledger,
    get handlers() {
      return [...handlers];
    },
    emit: (status) => {
      for (const handler of handlers) handler(status);
    },
  };
};

/** What the app heard from other apps. */
export type FakeLinks = {
  readonly layer: Layer.Layer<Links>;
  readonly ledger: ResourceLedger;
  /** The links the app was given. */
  readonly links: readonly string[];
  /** The shares the app was given. */
  readonly shares: readonly string[];
  /** Gives the app a link, as another app would. */
  readonly emitLink: (url: string) => void;
  /** Gives the app a share, as another app would. */
  readonly emitShare: (url: string) => void;
};

/** Links that keep what the app was given and hand it over when the test says so. */
export const fakeLinks = (ledger: ResourceLedger = new ResourceLedger()): FakeLinks => {
  const links: string[] = [];
  const shares: string[] = [];
  const linkHandlers = new Set<(url: string) => void>();
  const shareHandlers = new Set<(url: string) => void>();

  return {
    layer: Layer.succeed(Links)({
      initial: () => Effect.succeed(null),
      onLink: (handler) =>
        Effect.gen(function* () {
          const scope = yield* Scope.Scope;

          linkHandlers.add(handler);
          ledger.take("links.link");

          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              linkHandlers.delete(handler);
              ledger.give("links.link");
            }),
          );
        }),
      onShare: (handler) =>
        Effect.gen(function* () {
          const scope = yield* Scope.Scope;

          shareHandlers.add(handler);
          ledger.take("links.share");

          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              shareHandlers.delete(handler);
              ledger.give("links.share");
            }),
          );
        }),
      takeShare: () => Effect.suspend(() => Effect.succeed(shares.shift() ?? null)),
    }),
    ledger,
    links,
    shares,
    emitLink: (url) => {
      links.push(url);

      for (const handler of linkHandlers) handler(url);
    },
    emitShare: (url) => {
      shares.push(url);

      for (const handler of shareHandlers) handler(url);
    },
  };
};

/** The browser's own state, as the fake keeps it. */
export type FakeBrowserState = {
  readonly layer: Layer.Layer<BrowserState>;
  readonly ledger: ResourceLedger;
  /** The state as it is now. */
  readonly data: () => BrowserData;
  /** Whether the saved state has been read. */
  readonly ready: () => boolean;
  /** Says the saved state has been read. */
  readonly markReady: () => void;
};

/** A store in memory: a dispatch changes the state and tells the subscribers. */
export const fakeBrowserState = (ledger: ResourceLedger = new ResourceLedger()): FakeBrowserState => {
  let data = initialBrowserData(createTab("tab-1", Date.now()));
  let ready = false;
  const subscribers = new Set<(data: BrowserData, previous: BrowserData) => void>();

  return {
    layer: Layer.succeed(BrowserState)({
      data: () => Effect.succeed(data),
      ready: () => Effect.succeed(ready),
      dispatch: (action: BrowserAction) =>
        Effect.sync(() => {
          const previous = data;
          const next = reduceBrowserData(data, action);

          if (next === previous) return;

          data = next;

          for (const subscriber of subscribers) subscriber(data, previous);
        }),
      subscribe: (listener) =>
        Effect.gen(function* () {
          const scope = yield* Scope.Scope;

          subscribers.add(listener);
          ledger.take("browserState");

          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              subscribers.delete(listener);
              ledger.give("browserState");
            }),
          );
        }),
    }),
    ledger,
    data: () => data,
    ready: () => ready,
    markReady: () => {
      ready = true;
    },
  };
};
