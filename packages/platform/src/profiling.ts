// What Bay's documents time while a trace records them. The engine says when (ProfilingWatch: Help › Record
// Performance Issue, DevTools or the bay command over CDP, a --trace-startup launch), through the host info and an
// app event; the local preview and a CDP client can also call globalThis.bayProfiling. Each span is a User Timing
// measure, which Chrome writes into the trace beside V8's samples and the engine's own Bay.* events, and
// apps/browser/scripts/perf/trace.mjs reports them. While nothing records, a span costs a boolean check.
//
// Names are "Bay.<area> <subject>" (Bay.native BayCEF.engineCall, Bay.command updateSpace): the report groups by
// both. A span's detail carries numbers worth summing, such as bytes.

import * as v from "valibot";

export type SpanDetail = Record<string, string | number | boolean | null>;

let active = false;

// Hermes (macOS) has performance.now but no User Timing; macOS profiles with js-bench instead.
const measurable = v.is(v.function_(), globalThis.performance?.measure) && v.is(v.function_(), globalThis.performance?.clearMeasures);

/** A trace is recording the documents' timings now. */
export const profiling = (): boolean => active;

export function setProfiling(on: boolean) {
  if (on === active || (on && !measurable)) return;
  active = on;
}

/** Where a span begins: performance.now(), or -1 while nothing records, so a span begun before recording started is
 *  dropped rather than drawn from the page's start. */
export const spanStart = (): number => (active ? performance.now() : -1);

/** Records `name` from `start` to `end` (performance.now() times; now by default). */
export function span(name: string, start: number, detail?: SpanDetail, end?: number) {
  if (!active || start < 0) return;

  try {
    const options: PerformanceMeasureOptions = { start, end: end ?? performance.now() };

    if (detail) options.detail = detail;
    performance.measure(name, options);
    // The trace has it; the page's own timeline needn't keep thousands.
    performance.clearMeasures(name);
  } catch {}
}

/** Runs `run`, recorded as `name` while a trace records. */
export function timed<T>(name: string, run: () => T, detail?: SpanDetail): T {
  if (!active) return run();
  const start = performance.now();

  try {
    return run();
  } finally {
    span(name, start, detail);
  }
}

/** Bytes a string takes on the wire (UTF-16 length, close enough for JSON that is mostly ASCII). */
export const sizeOf = (text: string | null | undefined): number => text?.length ?? 0;

declare global {
  // For a CDP client and the local preview, which have no engine to say when a trace records.
  var bayProfiling: { start(): void; stop(): void; readonly active: boolean } | undefined;
}

globalThis.bayProfiling = {
  start: () => setProfiling(true),
  stop: () => setProfiling(false),
  get active() {
    return active;
  },
};
