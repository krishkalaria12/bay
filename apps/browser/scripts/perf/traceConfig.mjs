// What a Bay profile records on Windows and Linux. The engine's own recorder (Help › Record Performance Issue,
// engine/chromium/src/chrome/browser/bay/webui/tracing_session.cc) keeps the same list; trace.test.mjs checks they
// match.
//
// The documents' JavaScript sampled every millisecond with its source, their User Timing measures
// (packages/platform/src/profiling.ts), native stacks, tasks and IPC in every process, frames from input to the screen,
// the GPU, Bay's own runtime relay (Bay.* events, in "browser") and each process's memory every two seconds.
export const TRACE_CATEGORIES = [
  "toplevel",
  "toplevel.flow",
  "base",
  "browser",
  "startup",
  "navigation",
  "loading",
  "ipc",
  "mojom",
  "input",
  "latencyInfo",
  "benchmark",
  "cc",
  "viz",
  "gpu",
  "graphics.pipeline",
  "renderer.scheduler",
  "sequence_manager",
  "ui",
  "views",
  "blink",
  "blink.user_timing",
  "blink.console",
  "blink_gc",
  "v8",
  "v8.execute",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.stack",
  "disabled-by-default-devtools.target-rundown",
  "disabled-by-default-devtools.v8-source-rundown",
  "disabled-by-default-v8.cpu_profiler",
  "disabled-by-default-v8.gc",
  "disabled-by-default-cpu_profiler",
  "disabled-by-default-memory-infra",
];

export const MEMORY_DUMPS = { triggers: [{ mode: "light", periodic_interval_ms: 2000 }] };

// The newest 256 MB: a long recording keeps its end.
export const TRACE_BUFFER_KB = 262144;

/** For a --trace-startup launch: Chrome's switch takes the categories as one comma-separated list. */
export const startupCategories = () => TRACE_CATEGORIES.join(",");
