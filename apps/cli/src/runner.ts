import {
  ElementNotFound,
  Key,
  NavigationError,
  NoPageTab,
  PageLoadTimeout,
  ScriptEvaluationError,
  Session,
  Tab,
  WaitElementTimeout,
  WaitTimeout,
} from "./browser.ts";
import * as browsing from "./browsing.ts";
import { Endpoint, EndpointError } from "./endpoint.ts";
import { redact } from "./redact.ts";
import { createSourceFile, isExpressionStatement, ScriptKind, ScriptTarget } from "typescript";
import { ConnectionLost } from "./cdp.ts";
import { type JsonValue } from "./util.ts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import * as v from "valibot";

export const NO_PAGE_TAB = "the user isn't on a web page (New Tab or another Bay view); open one with new_tab(url) or pick one from tabs";
export const NO_VISIBLE_TAB = "no web page is visible (New Tab, another Bay view, or a hidden window); open one with new_tab(url) or pick one from tabs";

export class UserCodeError extends Error {
  override name = "UserCodeError";
  constructor(
    readonly error: Error,
    readonly filename: string,
  ) {
    super(error.message);
  }
}

export class ExecTimeout extends Error {
  override name = "ExecTimeout";
}

/** The run went wrong outside the user's code, and not for want of Bay. */
export class ExecError extends Error {
  override name = "ExecError";
}

// A failure outside the user's code: Bay's own, or the run's.
const runError = <E>(error: E): EndpointError | ExecError =>
  error instanceof EndpointError ? error : new ExecError(error instanceof Error ? error.message : String(error));

export function createNoTab(message = NO_PAGE_TAB) {
  return new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === Symbol.toPrimitive) return () => false;

        if (prop === "toString") return () => "<no web page tab>";

        if (prop === "valueOf") return () => false;

        if (prop === "then") return undefined;
        throw new NoPageTab(message);
      },
    },
  );
}

export function prepareCode(source: string): string {
  // Find the final expression before transpilation can discard its value.
  const parsed = createSourceFile("exec.ts", source, ScriptTarget.Latest, true, ScriptKind.TS);
  const last = parsed.statements.at(-1);

  if (last && isExpressionStatement(last)) {
    source = `${source.slice(0, last.getStart(parsed))}return (\n${last.expression.getText(parsed)}\n);${source.slice(last.end)}`;
  }

  const transpiler = new Bun.Transpiler({ loader: "ts" });

  return transpiler.transformSync(`return (async () => {\n${source}\n})();`).trim();
}

export function compileCode<Scope>(source: string, filename: string): (scope: Scope) => Promise<JsonValue> {
  const prepared = prepareCode(source);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const sourceUrl = filename.replace(/\s/g, (char) => encodeURIComponent(char));

  return new AsyncFunction("scope", `with (scope) {\n${prepared}\n}\n//# sourceURL=${sourceUrl}`);
}

export function buildNamespace(session: Session, filename: string, dataRoot?: string) {
  const tabs: Tab[] = [];

  const newTab = async (url = "about:blank", background = true): Promise<Tab> => {
    const tab = await session.newTab(url, background);
    tabs.push(tab);

    return tab;
  };

  const js = async (expression: string, tab?: Tab): Promise<JsonValue> => {
    const target = tab ?? (namespace.tab instanceof Tab ? namespace.tab : session.opened.at(-1));

    if (!target) {
      throw new NoPageTab(NO_PAGE_TAB);
    }

    // SAFETY: evaluate defaults to returnByValue + awaitPromise, so the CDP value is JSON-serializable, i.e. a JsonValue.
    return target.evaluate<JsonValue>(expression);
  };

  const pinned = async (): Promise<browsing.PinnedTab[]> => {
    return browsing.pinned(dataRoot ?? null);
  };

  const history = async (
    options: {
      days?: number;
      limit?: number | null;
      profile?: string | null;
      space?: string;
      domains?: boolean;
    } = {},
  ): Promise<JsonValue> => {
    return browsing.history(dataRoot ?? null, { ...options, space: options.space ?? options.profile ?? undefined });
  };

  const namespace = {
    __filename: filename,
    browser: session,
    session,
    tabs,
    newTab,
    new_tab: newTab,
    js,
    pinned,
    history,
    Key,
    Tab,
    NoPageTab,
    ElementNotFound,
    WaitElementTimeout,
    WaitTimeout,
    PageLoadTimeout,
    NavigationError,
    ScriptEvaluationError,
    BrowsingDataError: browsing.BrowsingDataError,
    tab: createNoTab(),
  };

  return namespace;
}

/** How a run of the user's code can end, other than with its value. */
export type RunFailure = UserCodeError | EndpointError | ExecTimeout | ExecError;

// The connection to Bay, for the scope: it is closed when the scope closes, however the run ended.
const connected = (endpoint: Endpoint): Effect.Effect<Session, EndpointError | ExecError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const session = new Session(endpoint);

      yield* Effect.tryPromise({
        try: () => session.connect(),
        catch: runError,
      }).pipe(Effect.onError(() => Effect.promise(() => session.close())));

      return session;
    }),
    (session) => Effect.promise(() => session.close()),
  );

/**
 * Runs the user's code against Bay and gives back its value. The connection is the run's: it closes when the run
 * ends, whether the code finished, failed, timed out, lost Bay or was interrupted (Ctrl-C). The code itself is a
 * promise the CLI cannot stop: an interrupted run stops waiting for it and closes the connection under it.
 */
export const runCodeEffect = (
  source: string,
  filename: string,
  endpoint: Endpoint,
  timeoutSeconds: number | null,
  dataRoot?: string,
): Effect.Effect<JsonValue, RunFailure> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fn = compileCode(source, filename);
      const session = yield* connected(endpoint);
      const lost = () => new EndpointError(`lost the connection to ${session.lost()}`);

      const prepare = Effect.tryPromise({
        try: async () => {
          const namespace = buildNamespace(session, filename, dataRoot);
          const active = await session.activeTarget();
          const pageTabs = await session.pageTabs(active);
          namespace.tabs.push(...pageTabs);

          const current = await session.currentTab(pageTabs, active);
          namespace.tab = current ?? createNoTab(NO_VISIBLE_TAB);

          return namespace;
        },
        catch: (error) => (error instanceof ConnectionLost ? lost() : runError(error)),
      });

      const namespace = yield* prepare;

      const execute = Effect.tryPromise({
        try: () => fn(namespace),
        catch: (error) => (error instanceof ConnectionLost ? lost() : new UserCodeError(error instanceof Error ? error : new Error(String(error)), filename)),
      });

      // Bay closing the connection ends the run, whatever the code is waiting for.
      const closed = Effect.promise(() => session.cdp.whenClosed()).pipe(Effect.andThen(Effect.fail(lost())));

      const run = Effect.raceFirst(execute, closed);

      if (!timeoutSeconds) return yield* run;

      return yield* run.pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(timeoutSeconds),
          orElse: () => Effect.fail(new ExecTimeout(`timed out after ${timeoutSeconds}s`)),
        }),
      );
    }),
  );

/** The same run, for a caller that wants a promise: a failure rejects with the error itself. */
export async function runCode(source: string, filename: string, endpoint: Endpoint, timeoutSeconds: number | null, dataRoot?: string): Promise<JsonValue> {
  const exit = await Effect.runPromiseExit(runCodeEffect(source, filename, endpoint, timeoutSeconds, dataRoot));

  if (Exit.isSuccess(exit)) return exit.value;

  throw Cause.squash(exit.cause);
}

export function formatValue<T>(value: T, asJson: boolean): string | null {
  if (asJson) {
    return JSON.stringify(value, (_, nested: JsonValue) => (v.is(v.bigint(), nested) ? nested.toString() : nested), 2) ?? null;
  }

  if (value === undefined || value === null) {
    return null;
  }

  if (v.is(v.string(), value)) {
    return value;
  }

  return Bun.inspect(value);
}

export function formatUserError(error: UserCodeError): string {
  const exc = error.error;
  const stack = exc.stack || `${exc.name}: ${exc.message}`;

  return redact(stack);
}

// A syntax error is the transpiler's message: its stack is the CLI's own frames, not the user's code.
export function formatSyntaxError(error: Error): string {
  return redact(`${error.name}: ${error.message}`);
}

export function printErr(text: string): void {
  const message = text.endsWith("\n") ? text : `${text}\n`;
  process.stderr.write(redact(message));
}
