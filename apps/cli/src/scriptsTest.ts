import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as v from "valibot";
import { Cdp, CdpError, ConnectionLost, isCdpObject, type CdpObject } from "./cdp.ts";
import { Endpoint, EndpointError, NOT_REACHABLE } from "./endpoint.ts";
import { redact } from "./redact.ts";
import * as urlmatch from "./urlmatch.ts";
import { Build, rules, SourceMap, SOURCE_URL_PREFIX } from "./userscript.ts";
import { type JsonValue } from "./util.ts";

export const CONNECT_TIMEOUT = 10_000;
export const RUN_TIMEOUT = 30_000;
export const LOAD_GRACE = 10_000;
export const CLEANUP_TIMEOUT = 5000;
export const EXPECT_POLL = 100;
export const MAX_PAGE_ERRORS = 5;
export const MAX_TEXT = 2000;

export const LEVELS = new Map<string, string>([
  ["warning", "warn"],
  ["startGroup", "group"],
  ["startGroupCollapsed", "groupCollapsed"],
  ["endGroup", "groupEnd"],
]);

const PRELUDE = `(() => {
const mark = __MARK__;
const rules = __RULES__;
const debug = console.debug.bind(console);
const href = location.href;
const top = window.top === window;
const verdict = (__MATCHER__)(rules, href);
if (rules.noframes && !top) { debug(mark, "skip", href, top, "@noframes"); return; }
if (verdict !== "run") { debug(mark, "skip", href, top, verdict); return; }
const run = () => {
debug(mark, "start", href, top, "");
try {
`;

const POSTLUDE = `} finally {
debug(mark, "done", href, top, "");
}
};
const afterDomReady = (next) => document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", next, { once: true }) : next();
const idle = () => {
let ran = false;
const go = () => { if (!ran) { ran = true; run(); } };
if (document.readyState === "complete") go();
else { window.addEventListener("load", go, { once: true }); setTimeout(go, 200); }
};
if (rules.runAt === "document-start") run();
else if (rules.runAt === "document-end") afterDomReady(run);
else afterDomReady(idle);
})();
//# sourceURL=__SOURCE_URL__
`;

export interface FrameResult {
  url: string;
  top: boolean;
  state: string;
  detail: string | null;
}

export interface ConsoleEntry {
  level: string;
  text: string;
  at: string;
  frame: "iframe" | null;
}

export interface ExceptionEntry {
  text: string;
  at?: string;
  frame: "iframe" | null;
}

export interface ExpectResult {
  truthy: boolean;
  value?: unknown;
  undefined?: boolean;
  error?: string;
  expression?: string;
}

interface RunReport {
  ok: boolean;
  ran: boolean;
  unfinished_passes: number;
  script: string;
  url: string;
  final_url: string | null;
  run_at: string;
  frames: FrameResult[];
  console: ConsoleEntry[];
  exceptions: ExceptionEntry[];
  page_errors: ExceptionEntry[];
  page_console_messages: number;
  expect: ExpectResult | null;
  screenshot: string | null;
  warnings: string[];
  error: string | null;
  kept_target: string | null;
}

export class Report {
  script: string;
  url: string;
  final_url: string | null = null;
  run_at = "";
  frames: FrameResult[] = [];
  console: ConsoleEntry[] = [];
  exceptions: ExceptionEntry[] = [];
  page_errors: ExceptionEntry[] = [];
  page_console = 0;
  expect: ExpectResult | null = null;
  screenshot: string | null = null;
  warnings: string[] = [];
  error: string | null = null;
  kept: string | null = null;

  constructor(script: string, url: string, run_at = "") {
    this.script = script;
    this.url = url;
    this.run_at = run_at;
  }

  get ran(): boolean {
    return this.frames.some((frame) => frame.state === "start" || frame.state === "done");
  }

  get unsettled(): number {
    const starts = this.frames.filter((f) => f.state === "start").length;
    const dones = this.frames.filter((f) => f.state === "done").length;

    return Math.max(0, starts - dones);
  }

  get ok(): boolean {
    if (this.error || !this.ran || this.exceptions.length > 0 || this.unsettled > 0) {
      return false;
    }

    return this.expect === null || (!this.expect.error && Boolean(this.expect.truthy));
  }

  to_dict(): RunReport {
    return {
      ok: this.ok,
      ran: this.ran,
      unfinished_passes: this.unsettled,
      script: this.script,
      url: this.url,
      final_url: this.final_url,
      run_at: this.run_at,
      frames: this.frames,
      console: this.console,
      exceptions: this.exceptions,
      page_errors: this.page_errors,
      page_console_messages: this.page_console,
      expect: this.expect,
      screenshot: this.screenshot,
      warnings: this.warnings,
      error: this.error,
      kept_target: this.kept,
    };
  }
}

export function wrap(build: Build, mark: string): [string, string, number] {
  const sourceUrl = `${SOURCE_URL_PREFIX}${build.meta.id}.user.js`;

  const head = PRELUDE.replace("__MARK__", JSON.stringify(mark))
    .replace("__RULES__", JSON.stringify(rules(build.meta)))
    .replace("__MATCHER__", urlmatch.JS);

  const body = build.js.endsWith("\n") ? build.js : `${build.js}\n`;
  const tail = POSTLUDE.replace("__SOURCE_URL__", sourceUrl);

  return [head + body + tail, sourceUrl, (head.match(/\n/g) || []).length];
}

export class Run {
  readonly mark: string;
  readonly source: string;
  readonly sourceUrl: string;
  readonly map: SourceMap;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly locationRegex: RegExp;
  topSession: string | null = null;
  topSettled = false;
  readonly topSettledWaiters: Array<() => void> = [];
  loaded = false;
  readonly loadedWaiters: Array<() => void> = [];
  readonly children = new Set<Promise<void>>();
  cdp: Cdp | null = null;

  constructor(
    readonly build: Build,
    readonly url: string,
    readonly report: Report,
  ) {
    this.mark = randomBytes(12).toString("hex");
    const [source, sourceUrl, offset] = wrap(build, this.mark);
    this.source = source;
    this.sourceUrl = sourceUrl;
    this.map = new SourceMap(build.sourcemap, offset);
    const bodyLines = (build.js.match(/\n/g) || []).length + (build.js.endsWith("\n") ? 0 : 1);
    this.bodyStart = offset;
    this.bodyEnd = offset + bodyLines;
    const escaped = sourceUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    this.locationRegex = new RegExp(`${escaped}:(\\d+):(\\d+)`, "g");
  }

  notifyTopSettled(): void {
    if (this.topSettled) return;
    this.topSettled = true;

    for (const waiter of this.topSettledWaiters) waiter();
    this.topSettledWaiters.length = 0;
  }

  waitTopSettled(timeoutMs: number): Promise<boolean> {
    if (this.topSettled) return Promise.resolve(true);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.topSettledWaiters.indexOf(done);

        if (idx !== -1) this.topSettledWaiters.splice(idx, 1);
        resolve(this.topSettled);
      }, timeoutMs);

      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };

      this.topSettledWaiters.push(done);
    });
  }

  notifyLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;

    for (const waiter of this.loadedWaiters) waiter();
    this.loadedWaiters.length = 0;
  }

  waitLoaded(timeoutMs: number): Promise<boolean> {
    if (this.loaded) return Promise.resolve(true);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.loadedWaiters.indexOf(done);

        if (idx !== -1) this.loadedWaiters.splice(idx, 1);
        resolve(this.loaded);
      }, timeoutMs);

      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };

      this.loadedWaiters.push(done);
    });
  }

  mapped(line: number, column: number): string {
    if (line < this.bodyStart || line >= this.bodyEnd) {
      return "bay test wrapper";
    }

    const found = this.map.lookup(line, column);

    if (found) {
      return `${found[0]}:${found[1]}:${found[2]}`;
    }

    const filename = this.build.path.split("/").pop() || "script";

    return `${filename} (compiled):${line - this.bodyStart + 1}:${column + 1}`;
  }

  mapText(text: string): string {
    return text.replace(this.locationRegex, (_, lineStr, colStr) => {
      return this.mapped(parseInt(lineStr, 10) - 1, parseInt(colStr, 10) - 1);
    });
  }

  ours(frames: Array<CdpObject>): CdpObject | null {
    return frames.find((f) => f.url === this.sourceUrl) || null;
  }

  onEvent(method: string, params: CdpObject, session: string | undefined): void {
    if (method === "Runtime.consoleAPICalled") {
      this.onConsole(params, session);
    } else if (method === "Runtime.exceptionThrown") {
      this.onException(isCdpObject(params.exceptionDetails) ? params.exceptionDetails : {}, session);
    } else if (method === "Page.loadEventFired" && session === this.topSession) {
      this.notifyLoaded();
    } else if (method === "Target.attachedToTarget" && session && v.is(v.string(), params.sessionId) && params.sessionId !== this.topSession) {
      const p = this.setupChild(params.sessionId, Boolean(params.waitingForDebugger));
      this.children.add(p);
      p.finally(() => this.children.delete(p));
    }
  }

  onConsole(params: CdpObject, session: string | undefined): void {
    const args = Array.isArray(params.args) ? params.args.filter(isCdpObject) : [];

    if (args.length && args[0]?.value === this.mark) {
      const values = args.slice(1, 5).map((a) => a.value);
      const [state, href, top, detail] = [values[0], values[1], values[2], values[3]];
      this.report.frames.push({
        url: String(href || ""),
        top: Boolean(top),
        state: String(state || ""),
        detail: detail ? String(detail) : null,
      });

      if (top && (state === "done" || state === "skip")) {
        this.notifyTopSettled();
      }

      return;
    }

    const stackTrace = isCdpObject(params.stackTrace) ? params.stackTrace : undefined;
    const rawFrames = isCdpObject(stackTrace) && Array.isArray(stackTrace.callFrames) ? stackTrace.callFrames : [];
    const frames = rawFrames.filter(isCdpObject);
    const frame = this.ours(frames);

    if (!frame) {
      this.report.page_console += 1;

      return;
    }

    const text = args.map((arg) => describeArg(arg)).join(" ");
    const type = String(params.type || "log");
    this.report.console.push({
      level: LEVELS.get(type) ?? type,
      text: clipText(this.mapText(text)),
      at: this.mapped(Number(frame.lineNumber || 0), Number(frame.columnNumber || 0)),
      frame: session === this.topSession ? null : "iframe",
    });
  }

  onException(details: CdpObject, session: string | undefined): void {
    const exception = isCdpObject(details.exception) ? details.exception : {};
    const description = exception.description || exception.value;
    const text = details.text || "Uncaught";
    const message = description && (text === "Uncaught" || text === "Uncaught (in promise)") ? `${text} ${description}` : description || text;
    const stackTrace = isCdpObject(details.stackTrace) ? details.stackTrace : undefined;
    const rawFrames = isCdpObject(stackTrace) && Array.isArray(stackTrace.callFrames) ? stackTrace.callFrames : [];
    const frames = rawFrames.filter(isCdpObject);
    const frame = this.ours(frames);
    const ours = frame !== null || details.url === this.sourceUrl || String(message).includes(this.sourceUrl);

    const entry: ExceptionEntry = {
      text: clipText(this.mapText(String(message))),
      frame: session === this.topSession ? null : "iframe",
    };

    if (frame !== null) {
      entry.at = this.mapped(Number(frame.lineNumber || 0), Number(frame.columnNumber || 0));
    } else if (details.url === this.sourceUrl) {
      entry.at = this.mapped(Number(details.lineNumber || 0), Number(details.columnNumber || 0));
    }

    if (ours) {
      this.report.exceptions.push(entry);
    } else if (this.report.page_errors.length < MAX_PAGE_ERRORS) {
      this.report.page_errors.push(entry);
    }
  }

  async setupChild(session: string, waiting: boolean): Promise<void> {
    if (!this.cdp) return;

    try {
      await this.cdp.send("Runtime.enable", {}, session);
      await this.cdp.send("Page.enable", {}, session);
      await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: this.source }, session);
      await this.cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, session);
    } catch {
    } finally {
      if (waiting) {
        try {
          await this.cdp.send("Runtime.runIfWaitingForDebugger", {}, session);
        } catch {}
      }
    }
  }
}

export function describeArg(arg: CdpObject): string {
  if (isCdpObject(arg.preview)) {
    return preview(arg.preview);
  }

  if ("value" in arg) {
    const val = arg.value;

    return v.is(v.string(), val) ? val : JSON.stringify(val);
  }

  if ("unserializableValue" in arg) {
    return String(arg.unserializableValue);
  }

  if (arg.type === "undefined") {
    return "undefined";
  }

  return String(arg.description || arg.className || arg.type || "?");
}

function preview(data: CdpObject): string {
  const items: string[] = [];
  const props = Array.isArray(data.properties) ? data.properties.filter(isCdpObject) : [];

  for (const prop of props) {
    let value = prop.value !== undefined ? prop.value : prop.type || "?";

    if (prop.type === "string") {
      value = JSON.stringify(value);
    }

    items.push(data.subtype === "array" ? String(value) : `${prop.name}: ${value}`);
  }

  if (data.overflow) {
    items.push("…");
  }

  if (data.subtype === "array") {
    return `[${items.join(", ")}]`;
  }

  if (data.type === "object" && (!data.subtype || data.subtype === "") && (data.description === "Object" || !data.description)) {
    return `{${items.join(", ")}}`;
  }

  const head = String(data.description || data.type || "?");

  return items.length ? `${head} {${items.join(", ")}}` : head;
}

export function clipText(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}… (${text.length - MAX_TEXT} more characters)`;
}

const EXPECT_WRAPPER = `(async () => {
const value = await (
__EXPRESSION__
);
let shown;
if (value === undefined) shown = { undefined: true };
else if (value === null || ["string", "number", "boolean"].includes(typeof value)) shown = { value };
else if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") shown = { value: String(value) };
else {
try { shown = { value: JSON.parse(JSON.stringify(value)) }; } catch { shown = { value: Object.prototype.toString.call(value) }; }
if (typeof Node !== "undefined" && value instanceof Node) shown = { value: value.nodeName ? \`<\${value.nodeName.toLowerCase()}>\` : String(value) };
}
return { truthy: Boolean(value), ...shown };
})()`;

export async function evaluateExpect(cdp: Cdp, session: string, expression: string): Promise<ExpectResult> {
  const result = await cdp.send(
    "Runtime.evaluate",
    {
      expression: EXPECT_WRAPPER.replace("__EXPRESSION__", expression),
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
    },
    session,
  );

  if (isCdpObject(result.exceptionDetails)) {
    const details = result.exceptionDetails;
    const exception = isCdpObject(details.exception) ? details.exception : {};

    return {
      truthy: false,
      error: clipText(String(exception.description || details.text || "threw")),
    };
  }

  const rawResult = isCdpObject(result.result) ? result.result : undefined;
  const value = rawResult?.value;

  if (!isCdpObject(value)) {
    return { truthy: false, error: "the expression's value couldn't be read" };
  }

  const val = value;

  return {
    truthy: Boolean(val.truthy),
    value: val.value,
    undefined: Boolean(val.undefined),
  };
}

export async function evaluatePlain(cdp: Cdp, session: string, expression: string): Promise<JsonValue> {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, session);
  const rawResult = isCdpObject(result.result) ? result.result : undefined;

  return rawResult?.value ?? null;
}

/**
 * Listens for `wait` seconds after the run: with an expression, it is asked again every EXPECT_POLL ms until it is
 * truthy, and the rest of the wait is listened through either way. Chrome reports an unhandled rejection about a
 * second late, so the wait is not cut short.
 */
export const listenExpect = (
  cdp: Cdp,
  session: string,
  expression: string | undefined,
  wait: number,
): Effect.Effect<ExpectResult | null, ConnectionLost | CdpError> =>
  Effect.gen(function* () {
    const deadline = Date.now() + Math.max(wait, 0) * 1000;

    if (!expression) {
      if (wait > 0) yield* Effect.sleep(Duration.seconds(wait));

      return null;
    }

    let outcome: ExpectResult;

    for (;;) {
      outcome = yield* cdpCall(() => evaluateExpect(cdp, session, expression));
      outcome.expression = expression;

      if ((!outcome.error && outcome.truthy) || Date.now() >= deadline) break;

      yield* Effect.sleep(Duration.millis(EXPECT_POLL));

      if (cdp.closed) return yield* Effect.fail(new ConnectionLost());
    }

    const remaining = deadline - Date.now();

    if (remaining > 0) yield* Effect.sleep(Duration.millis(remaining));

    return outcome;
  });

// A CDP step: its failures stay the connection's own, anything else is a CDP error.
const cdpCall = <A>(run: () => Promise<A>): Effect.Effect<A, ConnectionLost | CdpError> =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      error instanceof ConnectionLost || error instanceof CdpError ? error : new CdpError(error instanceof Error ? error.message : String(error)),
  });

export async function captureScreenshot(cdp: Cdp, session: string, path: string, report: Report): Promise<string | null> {
  try {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, session, 10_000);
    const target = resolve(path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(String(shot.data), "base64"));

    return target;
  } catch (error) {
    report.warnings.push(`no screenshot: ${error instanceof Error ? error.message : String(error)}`);

    return null;
  }
}

/**
 * Builds the run: a connection of its own, a background tab, the script registered at document start, and the page.
 * Each is a resource of the test's scope, so the tab closes and the script goes (unless --keep) and the connection
 * closes however the test ends: it finished, it failed, or it was interrupted.
 */
export const runTest = (
  build: Build,
  url: string,
  endpoint: Endpoint,
  expectExpr: string | undefined,
  wait: number,
  screenshotPath: string | undefined,
  keep: boolean,
): Effect.Effect<Report, EndpointError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const report = new Report(build.path, url, build.meta.run_at);
      report.warnings.push(...build.meta.warnings, ...build.warnings);

      if (build.meta.world === "ISOLATED") {
        report.warnings.push(
          "@inject-into content: this test runs the script in the page's world (bay command connections can't " +
            "create isolated worlds); installed, it runs in an isolated world and can't see page globals",
        );
      }

      const run = new Run(build, url, report);

      // The connection: Bay that can't be reached is the endpoint's failure, not the test's.
      const cdp = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const connection = new Cdp(endpoint.ws);

            try {
              await connection.open(CONNECT_TIMEOUT);
            } catch (error) {
              await connection.close();
              throw error;
            }

            return connection;
          },
          catch: (error) =>
            new EndpointError(
              endpoint.explicit ? redact(`can't connect to ${endpoint.source} (${error instanceof Error ? error.message : String(error)})`) : NOT_REACHABLE,
            ),
        }),
        (connection) => Effect.promise(() => connection.close()),
      );

      run.cdp = cdp;
      cdp.addListener((method, params, session) => run.onEvent(method, params, session));

      // A cleanup step: bounded, and never the test's failure.
      const cleanup = (step: () => Promise<CdpObject>) =>
        Effect.promise(() =>
          step().then(
            () => undefined,
            () => undefined,
          ),
        );

      const steps = Effect.gen(function* () {
        // The tab: kept for the user with --keep, else closed with the scope.
        const target = yield* Effect.acquireRelease(
          cdpCall(async () => {
            const created = await cdp.send("Target.createTarget", { url: "about:blank", background: true });

            if (!v.is(v.string(), created.targetId)) throw new CdpError("Target.createTarget returned no targetId");

            return created.targetId;
          }),
          (targetId) =>
            keep ? Effect.sync(() => void (report.kept = targetId)) : cleanup(() => cdp.send("Target.closeTarget", { targetId }, undefined, CLEANUP_TIMEOUT)),
        );

        const session = yield* cdpCall(async () => {
          const attached = await cdp.send("Target.attachToTarget", { targetId: target, flatten: true });

          if (!v.is(v.string(), attached.sessionId)) throw new CdpError("Target.attachToTarget returned no sessionId");

          await cdp.send("Runtime.enable", {}, attached.sessionId);
          await cdp.send("Page.enable", {}, attached.sessionId);

          return attached.sessionId;
        });

        run.topSession = session;

        // The script, registered at document start: taken out again with the scope, unless the tab is kept.
        yield* Effect.acquireRelease(
          cdpCall(async () => {
            const added = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: run.source }, session);

            return v.is(v.string(), added.identifier) && added.identifier ? added.identifier : null;
          }),
          (identifier) =>
            identifier && !keep ? cleanup(() => cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }, session, CLEANUP_TIMEOUT)) : Effect.void,
        );

        if (!build.meta.noframes) {
          yield* cdpCall(() => cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, session));
        }

        const navigated = yield* cdpCall(() => cdp.send("Page.navigate", { url }, session, RUN_TIMEOUT));

        if (navigated.errorText) {
          report.error = `couldn't open ${url}: ${navigated.errorText}`;

          return;
        }

        const settled = yield* Effect.promise(() => run.waitTopSettled(RUN_TIMEOUT));

        if (!settled || !run.topSettled) {
          report.error = report.unsettled
            ? `the script's first pass in the top frame didn't finish within ${RUN_TIMEOUT / 1000}s (an endless loop?)`
            : `the top frame didn't run or skip the script within ${RUN_TIMEOUT / 1000}s`;

          return;
        }

        yield* Effect.promise(() => run.waitLoaded(LOAD_GRACE));

        // Where the page ended up: an answer that doesn't come leaves it unknown.
        const info = yield* cdpCall(() => cdp.send("Target.getTargetInfo", { targetId: target })).pipe(Effect.catch(() => Effect.succeed(null)));
        const targetInfo = info && isCdpObject(info.targetInfo) ? info.targetInfo : undefined;

        if (info) report.final_url = (v.is(v.string(), targetInfo?.url) ? targetInfo.url : null) || null;

        report.expect = yield* listenExpect(cdp, session, expectExpr, wait);

        if (!build.meta.noframes) {
          const counted = yield* cdpCall(() => evaluatePlain(cdp, session, 'document.querySelectorAll("iframe, frame").length'));
          const frames = v.is(v.number(), counted) ? counted : 0;
          const reported = report.frames.filter((f) => !f.top && (f.state === "done" || f.state === "skip")).length;

          if (frames > reported) {
            report.warnings.push(
              `${frames - reported} of the page's ${frames} iframes never reported back: they hadn't loaded, or they show ` +
                "an extension's or the browser's own page, which Bay's control connection never reaches (a --port test " +
                "server does)",
            );
          }
        }

        if (screenshotPath) report.screenshot = yield* Effect.promise(() => captureScreenshot(cdp, session, screenshotPath, report));
      });

      // The connection lost is Bay's; any other failure is the report's.
      yield* steps.pipe(
        Effect.catch((error) => {
          if (error instanceof ConnectionLost) {
            return Effect.fail(new EndpointError(!endpoint.explicit ? NOT_REACHABLE : redact(`lost the connection to ${endpoint.source}`)));
          }

          return Effect.sync(() => {
            report.error = redact(error.message);
          });
        }),
      );

      return report;
    }),
  );

export function formatReport(report: Report): string {
  const lines: string[] = [];

  for (const warning of report.warnings) {
    lines.push(`warning: ${warning}`);
  }

  lines.push(`url: ${report.final_url || report.url}`);
  const top = report.frames.filter((f) => f.top);
  const sub = report.frames.filter((f) => !f.top);

  if (top.length) {
    const last = top[top.length - 1];

    if (last && last.state === "skip") {
      lines.push(`top frame: skipped (${last.detail})`);
    } else if (last && last.state === "start") {
      lines.push(`top frame: ran at ${report.run_at}, but its first pass never finished`);
    } else {
      lines.push(`top frame: ran at ${report.run_at}`);
    }
  } else if (!report.error) {
    lines.push("top frame: the script never ran");
  }

  if (sub.length) {
    const ran = sub.filter((f) => f.state === "done").length;
    const skipped = sub.filter((f) => f.state === "skip").length;
    lines.push(`iframes: ran in ${ran}, skipped ${skipped}`);
  }

  for (const entry of report.console) {
    const where = `  (${entry.at}${entry.frame ? ", iframe" : ""})`;
    lines.push(`console.${entry.level}: ${entry.text}${where}`);
  }

  for (const entry of report.exceptions) {
    const where = entry.at && !entry.text.includes(entry.at) ? `  (${entry.at})` : "";
    lines.push(`exception${entry.frame ? " in iframe" : ""}: ${entry.text}${where}`);
  }

  for (const entry of report.page_errors) {
    const first = entry.text.split("\n")[0] || "";
    lines.push(`page error (not from the script): ${first}`);
  }

  if (report.expect !== null) {
    if (report.expect.error) {
      lines.push(`expect: ${report.expect.expression} threw ${report.expect.error}`);
    } else {
      const val = report.expect.undefined ? "undefined" : JSON.stringify(report.expect.value);
      const verdict = report.expect.truthy ? "truthy" : "falsy";
      lines.push(`expect: ${report.expect.expression} -> ${clipText(val)} (${verdict})`);
    }
  }

  if (report.screenshot) {
    lines.push(`screenshot: ${report.screenshot}`);
  }

  if (report.kept) {
    lines.push(`kept the tab open (target ${report.kept})`);
  }

  lines.push(report.ok ? "ok" : `failed: ${failure(report)}`);

  return redact(lines.join("\n"));
}

export function failure(report: Report): string {
  if (report.error) return report.error;

  if (!report.ran) return "the script didn't run on this page";

  if (report.exceptions.length > 0) {
    return `${report.exceptions.length} uncaught exception${report.exceptions.length > 1 ? "s" : ""}`;
  }

  if (report.unsettled > 0) return "the script's first pass never finished in some frame (an endless loop?)";

  return "--expect wasn't truthy";
}
