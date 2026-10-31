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

export class ExecInterrupted extends Error {
  override name = "ExecInterrupted";
}

export function createNoTab(message = NO_PAGE_TAB): unknown {
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

export function compileCode(source: string, filename: string): (scope: Record<string, unknown>) => Promise<unknown> {
  const prepared = prepareCode(source);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const sourceUrl = filename.replace(/\s/g, (char) => encodeURIComponent(char));
  return new AsyncFunction("scope", `with (scope) {\n${prepared}\n}\n//# sourceURL=${sourceUrl}`);
}

export function buildNamespace(session: Session, filename: string, dataRoot?: string): Record<string, unknown> {
  const tabs: Tab[] = [];

  const newTab = async (url = "about:blank", background = true): Promise<Tab> => {
    const tab = await session.newTab(url, background);
    tabs.push(tab);
    return tab;
  };

  const js = async (expression: string, tab?: Tab): Promise<unknown> => {
    const target = tab ?? (namespace.tab instanceof Tab ? namespace.tab : session.opened.at(-1));
    if (!target) {
      throw new NoPageTab(NO_PAGE_TAB);
    }
    return target.evaluate(expression);
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
  ): Promise<unknown> => {
    return browsing.history(dataRoot ?? null, { ...options, space: options.space ?? options.profile ?? undefined });
  };

  const namespace: Record<string, unknown> = {
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

export async function runCode(source: string, filename: string, endpoint: Endpoint, timeoutSeconds: number | null, dataRoot?: string): Promise<unknown> {
  const fn = compileCode(source, filename);
  const session = new Session(endpoint);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let interrupt: (() => void) | undefined;

  try {
    await session.connect();
    const namespace = buildNamespace(session, filename, dataRoot);
    const active = await session.activeTarget();
    const pageTabs = await session.pageTabs(active);
    (namespace.tabs as Tab[]).push(...pageTabs);

    const current = await session.currentTab(pageTabs, active);
    namespace.tab = current ?? createNoTab(NO_VISIBLE_TAB);

    const timeoutMs = timeoutSeconds ? timeoutSeconds * 1000 : 0;
    const executePromise = (async () => {
      try {
        return await fn(namespace);
      } catch (error) {
        if (error instanceof ConnectionLost) throw new EndpointError(`lost the connection to ${session.lost()}`);
        throw new UserCodeError(error instanceof Error ? error : new Error(String(error)), filename);
      }
    })();

    const cdpClosedPromise = session.cdp.whenClosed().then(() => {
      throw new EndpointError(`lost the connection to ${session.lost()}`);
    });
    const interrupted = new Promise<never>((_, reject) => {
      interrupt = () => reject(new ExecInterrupted("interrupted"));
      for (const signal of signals) process.on(signal, interrupt);
    });

    if (timeoutMs > 0) {
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ExecTimeout(`timed out after ${timeoutSeconds}s`)), timeoutMs);
      });
      return await Promise.race([executePromise, cdpClosedPromise, timeoutPromise, interrupted]);
    }

    return await Promise.race([executePromise, cdpClosedPromise, interrupted]);
  } finally {
    if (interrupt) for (const signal of signals) process.off(signal, interrupt);
    clearTimeout(timer);
    await session.close();
  }
}

export function formatValue(value: unknown, asJson: boolean): string | null {
  if (asJson) {
    return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) ?? null;
  }
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return Bun.inspect(value);
}

export function formatUserError(error: UserCodeError): string {
  const exc = error.error;
  const stack = exc.stack || `${exc.name}: ${exc.message}`;
  return redact(stack);
}

export function formatSyntaxError(error: Error): string {
  return redact(error.stack || `${error.name}: ${error.message}`);
}

export function printErr(text: string): void {
  const message = text.endsWith("\n") ? text : `${text}\n`;
  process.stderr.write(redact(message));
}
