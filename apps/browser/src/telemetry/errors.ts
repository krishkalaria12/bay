import { crashReports, systemInfo } from "@bay/desktop";
import { advanceCrashCursor, capture, crashCursor, isSharing, loadChoice } from "./client";
import { recordLog } from "./logs";
import * as v from "valibot";
import { errorCode, errorMessage, errorType, nativeCrashExceptions, parseStack, type ExceptionFrame, type TelemetryError } from "./sanitize";
import { MAX_ERRORS_PER_SESSION } from "./config";

type Mechanism = "onerror" | "onunhandledrejection" | "react" | "console" | "native_crash";

const reported = new WeakSet<object>();
const seen = new Set<string>();

function exceptionList(type: string, value: string, mechanism: Mechanism, handled: boolean, frames: ExceptionFrame[]) {
  return [{ type, value, mechanism: { type: mechanism, handled, synthetic: false }, stacktrace: { type: "raw", frames } }];
}

export function captureException(error: TelemetryError, mechanism: Mechanism, { fatal = false, handled = false } = {}) {
  if (!isSharing()) return;

  try {
    if (Array.isArray(error) || v.is(v.object({}), error)) {
      // SAFETY: error is an object or array, so it can be tracked by identity.
      if (reported.has(error as object)) return;

      // SAFETY: error is an object or array, so it can be tracked by identity.
      reported.add(error as object);
    }

    const type = errorType(error);
    const value = errorMessage(error) || type;

    // SAFETY: error is an object or array, so reading its stack field is safe; otherwise stack is undefined.
    const rawStack = Array.isArray(error) || v.is(v.object({}), error) ? (error as { stack?: unknown }).stack : undefined;
    const frames = parseStack(v.is(v.string(), rawStack) ? rawStack : undefined);
    const code = errorCode(error);
    const key = `${type}|${value}|${code ?? ""}|${frames.at(-1)?.function ?? ""}`;

    if (seen.has(key) || seen.size >= MAX_ERRORS_PER_SESSION) return;
    seen.add(key);
    capture(
      "$exception",
      { $exception_level: fatal ? "fatal" : "error", source: mechanism, error_code: code },
      // Persist the telemetry queue before a fatal process exit.
      { urgent: true, persist: fatal, raw: { $exception_list: exceptionList(type, value, mechanism, handled, frames) } },
    );
  } catch {}
}

type ErrorUtilsType = {
  getGlobalHandler?: () => ((error: TelemetryError, isFatal?: boolean) => void) | undefined;
  setGlobalHandler?: (handler: (error: TelemetryError, isFatal?: boolean) => void) => void;
};

type HermesInternalType = {
  enablePromiseRejectionTracker?: (options: {
    allRejections: boolean;
    onUnhandled: (id: number, rejection: TelemetryError) => void;
    onHandled: (id: number) => void;
  }) => void;
};

let installed = false;

export function installErrorReporting() {
  if (installed) return;
  installed = true;
  loadChoice();

  // SAFETY: globalThis holds the host ErrorUtils and HermesInternal hooks when present.
  const g = globalThis as { ErrorUtils?: ErrorUtilsType; HermesInternal?: HermesInternalType };

  const previous = g.ErrorUtils?.getGlobalHandler?.();
  g.ErrorUtils?.setGlobalHandler?.((error, isFatal) => {
    captureException(error, "onerror", { fatal: !!isFatal });
    previous?.(error, isFatal);
  });

  g.HermesInternal?.enablePromiseRejectionTracker?.({
    allRejections: true,
    onUnhandled: (id, rejection) => {
      captureException(rejection, "onunhandledrejection");

      if (__DEV__) console.warn(`Possible unhandled promise rejection (id: ${id})`, rejection);
    },
    onHandled: () => {},
  });

  for (const level of ["error", "warn"] as const) {
    const original = console[level];
    let busy = false;
    console[level] = (...args: unknown[]) => {
      if (!busy) {
        busy = true;

        try {
          const first = args[0];

          if (level === "error" && first instanceof Error) {
            // SAFETY: first is an Error already narrowed by instanceof, so reading its React flag is safe.
            captureException(first, (first as { isComponentError?: boolean }).isComponentError ? "react" : "console");
          } else recordLog(level, args);
        } catch {}

        busy = false;
      }

      original.apply(console, args);
    };
  }
}

export async function reportNativeCrashes() {
  if (!isSharing()) return;
  const since = crashCursor();
  const reports = await crashReports(since).catch(() => []);
  const version = systemInfo().appVersion;
  let latest = since;

  for (const report of reports) {
    latest = Math.max(latest, report.time);

    if (report.appVersion && report.appVersion !== version) continue;
    const { name, signal, exceptions } = nativeCrashExceptions(report);
    capture(
      "$exception",
      {
        $exception_level: "fatal",
        source: "native_crash",
        crash_signal: signal,
        objc_exception: name,
        crashed_minutes_ago: Math.round((Date.now() - report.time) / 60_000),
      },
      {
        urgent: true,
        raw: { $exception_list: exceptions.flatMap((e) => exceptionList(e.type, e.value, "native_crash", false, e.frames)) },
      },
    );
  }

  advanceCrashCursor(latest);
}
