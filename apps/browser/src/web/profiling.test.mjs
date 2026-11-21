import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setProfiling } from "@bay/platform/profiling";
import { TRACE_CATEGORIES } from "../../scripts/perf/traceConfig.mjs";
import { compareReports, reportTrace } from "../../scripts/perf/traceReport.mjs";

test("the engine's recorder and trace.mjs record the same categories", () => {
  const source = readFileSync(new URL("../../../../engine/chromium/src/chrome/browser/bay/webui/tracing_session.cc", import.meta.url), "utf8");
  const list = /"included_categories": \[([^\]]*)\]/.exec(source)?.[1];
  assert.ok(list, "tracing_session.cc lists its categories");
  assert.deepEqual([...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort(), [...TRACE_CATEGORIES].sort());
});

test("a React commit names the components that rendered in it, and skips subtrees React bailed out of", async (t) => {
  const measures = [];
  t.mock.method(performance, "measure", (name, options) => void measures.push({ name, ...options }));
  t.mock.method(performance, "clearMeasures", () => {});
  delete globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  await import("./reactProfiling.ts");
  const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  assert.equal(hook.inject({}), 1);

  const fiber = (tag, type, flags, children = [], alternate = {}) => {
    const f = { tag, type, flags, child: null, sibling: null, alternate };

    for (const child of children.reverse()) {
      child.sibling = f.child;
      f.child = child;
    }

    return f;
  };

  function TabRow() {}

  const Sidebar = { displayName: "Sidebar" };
  // A sidebar that rendered two rows, one mounted; a bailed-out subtree whose stale fibers must not count.
  const stale = fiber(0, TabRow, 1);
  const untouched = fiber(0, function Untouched() {}, 0, [stale]);
  untouched.alternate = { child: untouched.child };
  const root = fiber(3, null, 0, [fiber(11, Sidebar, 1, [fiber(0, TabRow, 1), fiber(0, TabRow, 0, [], null)]), untouched]);

  hook.onCommitFiberRoot(1, { current: root });
  setProfiling(true);
  t.after(() => setProfiling(false));
  hook.onCommitFiberRoot(1, { current: root });
  const commit = measures.find((m) => m.name === "Bay.react commit");
  assert.deepEqual(commit.detail, { renders: 3, mounts: 1, components: "TabRow:2,Sidebar:1" });
});

// The shapes Chrome 157 writes: measures as async b/e with their detail, engine events as X, and main-thread tasks.
const trace = [
  { ph: "M", name: "process_name", pid: 1, tid: 0, args: { name: "Browser" } },
  { ph: "M", name: "process_name", pid: 2, tid: 0, args: { name: "Renderer" } },
  { ph: "M", name: "thread_name", pid: 1, tid: 10, args: { name: "CrBrowserMain" } },
  { ph: "M", name: "thread_name", pid: 2, tid: 20, args: { name: "CrRendererMain" } },
  { ph: "I", name: "TracingStartedInBrowser", pid: 1, tid: 10, ts: 1_000_000, cat: "disabled-by-default-devtools.timeline", args: {} },
  {
    ph: "X",
    name: "FunctionCall",
    pid: 2,
    tid: 20,
    ts: 1_000_100,
    dur: 10,
    cat: "devtools.timeline",
    args: { data: { url: "chrome://bay/_expo/static/js/web/index-0123456789abcdef0123.js" } },
  },
  {
    ph: "b",
    name: "Bay.command openTab",
    pid: 2,
    tid: 20,
    ts: 1_001_000,
    cat: "blink.user_timing",
    id2: { local: "0x1" },
    args: { detail: '{"bytes":2048}' },
  },
  { ph: "e", name: "Bay.command openTab", pid: 2, tid: 20, ts: 1_005_000, cat: "blink.user_timing", id2: { local: "0x1" }, args: {} },
  { ph: "b", name: "Bay.command openTab", pid: 2, tid: 20, ts: 1_010_000, cat: "blink.user_timing", id2: { local: "0x1" }, args: {} },
  { ph: "e", name: "Bay.command openTab", pid: 2, tid: 20, ts: 1_022_000, cat: "blink.user_timing", id2: { local: "0x1" }, args: {} },
  { ph: "X", name: "Bay.Runtime.Publish", pid: 1, tid: 10, ts: 1_002_000, dur: 1500, cat: "browser", args: { bytes: 4096 } },
  { ph: "X", name: "ThreadControllerImpl::RunTask", pid: 1, tid: 10, ts: 1_002_000, dur: 60_000, cat: "toplevel" },
  { ph: "X", name: "ThreadControllerImpl::RunTask", pid: 1, tid: 10, ts: 1_010_000, dur: 1000, cat: "toplevel" },
  { ph: "X", name: "ThreadControllerImpl::RunTask", pid: 2, tid: 20, ts: 1_100_000, dur: 2000, cat: "toplevel" },
];

test("a report times Bay's spans, the engine's and each main thread", () => {
  const { numbers, longTasks, processes } = reportTrace(trace);
  assert.equal(processes.find((p) => p.pid === 2).label, "bay chrome://bay/");
  assert.deepEqual(numbers.bay["Bay.command openTab"], { count: 2, total: 16, p50: 12, p95: 12, max: 12, kb: 2 });
  assert.deepEqual(numbers.bay["Bay.Runtime.Publish [engine]"], { count: 1, total: 1.5, p50: 1.5, p95: 1.5, max: 1.5, kb: 4 });
  // The nested task is part of the long one.
  assert.equal(numbers.mainThreads["browser  CrBrowserMain"].busyMs, 60);
  assert.equal(numbers.mainThreads["browser  CrBrowserMain"].longTasks, 1);
  assert.deepEqual(
    longTasks.map((t) => [t.process, t.ms, t.at]),
    [["browser", 60, 0]],
  );
});

test("a comparison lists what moved by 10% or more", () => {
  const before = reportTrace(trace).numbers;
  const after = structuredClone(before);
  after.bay["Bay.command openTab"].p95 = 6;
  after.mainThreads["browser  CrBrowserMain"].busyMs = 62;
  const moved = compareReports(before, after).rows.filter((r) => Math.abs(r.change) >= 10);
  assert.deepEqual(
    moved.map((r) => [r.name, r.metric, r.change]),
    [["Bay.command openTab", "p95", -50]],
  );
});
