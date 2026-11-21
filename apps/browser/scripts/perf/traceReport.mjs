// Reads a Chrome trace of Bay on Windows or Linux (trace.mjs record, Help › Record Performance Issue, a
// --trace-startup launch) and says where the time went: Bay's own spans (the documents' User Timing measures from
// packages/platform/src/profiling.ts and the engine's Bay.* events), each process's busy main thread and long tasks,
// the JavaScript that ran (V8's samples, by function), frames, input latency, garbage collection, IPC and memory.
// `numbers` is the part `compare` diffs. trace.mjs is the command line.
import { createReadStream } from "node:fs";
import * as v from "valibot";
import { createGunzip } from "node:zlib";

// MARK: Reading

/**
 * The trace's events, streamed: a profile is easily larger than one JavaScript string can hold. Takes Chrome's JSON
 * trace ({"traceEvents": [...]} or a bare array), gzipped or not.
 */
export async function readTrace(file) {
  const events = [];
  let input = createReadStream(file);

  if (file.endsWith(".gz")) input = input.pipe(createGunzip());
  input.setEncoding("utf8");

  // The scanner keeps the text of the event it is in; outside one it looks for the array of events.
  let inArray = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let current = "";
  let head = "";

  for await (const chunk of input) {
    let start = 0;

    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];

      if (!inArray) {
        head += c;

        // The first "[" that opens the events: a bare array's, or "traceEvents"'s.
        if (c === "[" && (/^\s*\[$/.test(head) || /"traceEvents"\s*:\s*\[$/.test(head))) {
          inArray = true;
          start = i + 1;
        } else if (head.length > 4096) head = head.slice(-64);

        continue;
      }

      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;

        continue;
      }

      if (c === '"') inString = true;
      else if (c === "{") {
        if (depth++ === 0) start = i;
      } else if (c === "}") {
        if (--depth === 0) {
          events.push(JSON.parse(current + chunk.slice(start, i + 1)));
          current = "";
        }
      } else if (c === "]" && depth === 0) {
        // The end of the events; the metadata after them isn't needed.
        inArray = false;
        head = "";
      }
    }

    if (inArray && depth > 0) current += chunk.slice(start);
  }

  return events;
}

// MARK: Statistics

const round = (n, places = 1) => Math.round(n * 10 ** places) / 10 ** places;

function percentile(sorted, p) {
  if (!sorted.length) return 0;

  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Count, total, median, 95th percentile and worst of durations in ms. */
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, v) => sum + v, 0);

  return {
    count: sorted.length,
    total: round(total),
    p50: round(percentile(sorted, 50), 2),
    p95: round(percentile(sorted, 95), 2),
    max: round(sorted.at(-1) ?? 0, 2),
  };
}

/** Merged length of intervals [start, end) in µs. */
function union(intervals) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let from = 0;
  let to = -Infinity;

  for (const [start, end] of sorted) {
    if (start > to) {
      if (Number.isFinite(to)) total += to - from;
      from = start;
      to = end;
    } else to = Math.max(to, end);
  }

  return Number.isFinite(to) ? total + to - from : total;
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

// MARK: Processes

// Bay's documents and Chrome's pages, from the scripts each renderer ran (and the frames it committed, when the trace
// says).
function label(process) {
  const urls = [...process.urls];
  const bay = urls.filter((url) => url.startsWith("chrome://bay"));

  if (process.name === "Browser") return "browser";

  if (/GPU/i.test(process.name)) return "gpu";

  if (bay.length) return `bay ${bay.length > 1 ? `(${bay.length} documents)` : bay[0]}`;
  const local = urls.find((url) => /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url));

  if (local) return `bay preview ${new URL(local).host}`;
  const page = urls.find((url) => /^https?:/.test(url));

  if (page) return `page ${new URL(page).host}`;

  if (process.labels) return `${(process.name || "process").toLowerCase()} ${process.labels}`;

  return (process.name || "process").toLowerCase();
}

// MARK: JavaScript samples

const IDLE = new Set(["(idle)", "(program)", "(root)"]);

// What part of Bay a sampled function is in, from its script and name. The web bundle is one script, so React's and
// the other packages' functions are told apart by name (the build keeps them: apps/browser/metro.config.js).
function layerOf(frame) {
  const { functionName: fn, url } = frame;

  if (fn === "(garbage collector)") return "garbage collection";

  if (!url) return fn.startsWith("(") ? "engine" : "DOM and browser APIs";

  if (/^chrome-extension:|^devtools:/.test(url)) return "other";

  if (
    /^(performWorkOnRoot|workLoop|beginWork|completeWork|commit[A-Z]|reconcile|render(Root|WithHooks)|update(Function|Memo|SimpleMemo|ForwardRef|Reducer|State)|mount[A-Z]|recursivelyTraverse|flushPassiveEffects|flushSync|scheduleUpdateOnFiber|dispatchSetState|use[A-Z]\w*Impl|bailout|createFiber|diffHydrated|setInitialProperties|updateProperties|getRootForUpdatedFiber|markUpdateLaneFromFiberToRoot)/.test(
      fn,
    )
  )
    return "React";

  if (
    /^(createResolver|createStyleResolver|resolve|inline|flatten|preprocess|createCSSStyleSheet|insert|atomic|compileAndInsertAtomic|createReactDOMStyle|css|styleq)/i.test(
      fn,
    ) &&
    /StyleSheet|styleq|css/i.test(fn + url)
  )
    return "react-native-web styles";

  if (/^(subscribe|setState|getState|useStore|useSyncExternalStore|checkIfSnapshotChanged|createStore)/.test(fn)) return "store";

  if (/^(_?parse|_?run|is|object|string|array|number|safeParse|pipe)$/.test(fn)) return "valibot or JSON";

  return "Bay and its packages";
}

function addProfile(profiles, event) {
  const key = `${event.pid}:${event.id}`;
  let profile = profiles.get(key);

  if (!profile) profiles.set(key, (profile = { pid: event.pid, tid: event.tid, nodes: new Map(), samples: [], deltas: [] }));
  const data = event.args?.data;

  if (event.name === "Profile") return;
  const cpu = data?.cpuProfile;

  for (const node of cpu?.nodes ?? []) profile.nodes.set(node.id, node);
  profile.samples.push(...(cpu?.samples ?? []));
  profile.deltas.push(...(data?.timeDeltas ?? []));
}

// Self time per function and per layer, and inclusive time per function, in ms, per process.
function sampleTimes(profiles, top) {
  const byPid = new Map();

  for (const profile of profiles.values()) {
    let entry = byPid.get(profile.pid);

    if (!entry) byPid.set(profile.pid, (entry = { self: new Map(), total: new Map(), layers: new Map(), busy: 0 }));

    const describe = (node) => {
      const f = node.callFrame ?? {};
      const file = (f.url ?? "").replace(/^.*\//, "").replace(/-[0-9a-f]{16,}\.js$/, ".js");

      return {
        label: `${f.functionName || "(anonymous)"}${file ? `  ${file}:${(f.lineNumber ?? 0) + 1}` : ""}`,
        frame: { functionName: f.functionName ?? "", url: f.url ?? "" },
      };
    };

    for (let i = 0; i < profile.samples.length; i++) {
      const node = profile.nodes.get(profile.samples[i]);
      // A sample stands for the time until the next one.
      const ms = (profile.deltas[i + 1] ?? profile.deltas[i] ?? 0) / 1000;

      if (!node || ms <= 0 || ms > 100 || IDLE.has(node.callFrame?.functionName)) continue;
      const { label: name, frame } = describe(node);
      entry.busy += ms;
      bump(entry.self, name, ms);
      bump(entry.layers, layerOf(frame), ms);
      const seen = new Set();

      for (let at = node; at; at = profile.nodes.get(at.parent)) {
        const { label: outer } = describe(at);

        if (IDLE.has(at.callFrame?.functionName) || seen.has(outer)) continue;
        seen.add(outer);
        bump(entry.total, outer, ms);
      }
    }
  }

  const list = (map, n = top) =>
    [...map]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([name, ms]) => [name, round(ms)]);

  return new Map([...byPid].map(([pid, e]) => [pid, { busy: round(e.busy), layers: list(e.layers, 12), self: list(e.self), total: list(e.total, top * 2) }]));
}

// MARK: Report

const MAIN_THREADS = /^(CrBrowserMain|CrRendererMain|CrGpuMain|VizCompositorThread|Compositor)$/;
const LONG_TASK_MS = 50;

/** Everything the report says, from a trace's events. */
export function reportTrace(events, { top = 20 } = {}) {
  const processes = new Map();
  const threads = new Map();

  const process = (pid) => {
    let p = processes.get(pid);

    if (!p) processes.set(pid, (p = { pid, name: "", labels: "", urls: new Set() }));

    return p;
  };

  // Durations of paired events: B/E on a thread, b/e (and the async n) by id.
  const open = new Map();
  const spans = [];
  let first = Infinity;
  let last = -Infinity;
  // When recording began: async events can begin long before (a compositor's frame sequence).
  let started = null;

  const finish = (begin, end, endArgs) => {
    spans.push({ ...begin, dur: end.ts - begin.ts, args: { ...begin.args, ...endArgs } });
  };

  const tasks = new Map();
  const profiles = new Map();
  const memory = new Map();

  for (const e of events) {
    if (e.ph === "M") {
      if (e.name === "process_name") process(e.pid).name = e.args?.name ?? "";
      else if (e.name === "process_labels") process(e.pid).labels = e.args?.labels ?? "";
      else if (e.name === "thread_name") threads.set(`${e.pid}:${e.tid}`, e.args?.name ?? "");

      continue;
    }

    if (v.is(v.number(), e.ts) && e.ts > 0) {
      first = Math.min(first, e.ts);
      last = Math.max(last, e.ts + (e.dur ?? 0));
    }

    if (e.name === "TracingStartedInBrowser") started = e.ts;

    if (e.pid > 0) process(e.pid);

    // Which documents each renderer holds.
    const data = e.args?.data;

    if (e.name === "TracingStartedInBrowser")
      for (const frame of data?.frames ?? []) if (frame.url && frame.processId) process(frame.processId).urls.add(frame.url);

    if ((e.name === "FrameCommittedInBrowser" || e.name === "CommitLoad") && data?.url) process(data.processId ?? e.pid).urls.add(data.url);
    else if ((e.name === "FunctionCall" || e.name === "EvaluateScript" || e.name === "ScriptCatchup") && data?.url) {
      // The script's origin stands for its document's.
      const origin = /^(chrome:\/\/[^/]+\/|https?:\/\/[^/]+\/)/.exec(data.url)?.[1];

      if (origin) process(e.pid).urls.add(origin);
    }

    if (e.name === "Profile" || e.name === "ProfileChunk") {
      addProfile(profiles, e);

      continue;
    }

    if (e.ph === "v" && e.args?.dumps) {
      const totals = e.args.dumps.process_totals ?? {};
      const allocators = e.args.dumps.allocators ?? {};
      // Sizes are hexadecimal strings.
      const bytes = (value) => (v.is(v.string(), value) ? Number.parseInt(value, 16) : (value ?? 0));
      const size = (name) => bytes(allocators[name]?.attrs?.size?.value);

      const sample = {
        footprint: bytes(totals.private_footprint_bytes),
        v8: size("v8"),
        blink: size("blink_gc"),
        malloc: size("malloc"),
        partition: size("partition_alloc"),
      };

      let peak = memory.get(e.pid);

      if (!peak) memory.set(e.pid, (peak = { ...sample }));

      for (const key of Object.keys(sample)) peak[key] = Math.max(peak[key], sample[key]);

      continue;
    }

    const thread = `${e.pid}:${e.tid}`;

    if (e.ph === "X") {
      spans.push(e);

      // The thread's own tasks: "toplevel" is what its message loop ran.
      if (e.cat?.split(",").includes("toplevel") && e.dur > 0) {
        let list = tasks.get(thread);

        if (!list) tasks.set(thread, (list = []));
        list.push([e.ts, e.ts + e.dur, e.name]);
      }
    } else if (e.ph === "B") {
      const stack = open.get(thread) ?? [];
      stack.push(e);
      open.set(thread, stack);
    } else if (e.ph === "E") {
      const begin = open.get(thread)?.pop();

      if (begin) finish(begin, e, e.args);
    } else if (e.ph === "b" || e.ph === "e" || e.ph === "s" || e.ph === "f") {
      // Async spans pair by id; flows (Chrome's animation frames) by theirs.
      const id = e.id2?.local ?? e.id2?.global ?? e.id;
      const key = `${e.ph === "s" || e.ph === "f" ? "flow" : "async"}|${e.pid}|${e.cat}|${id}|${e.name}`;

      if (e.ph === "b" || e.ph === "s") {
        const stack = open.get(key) ?? [];
        stack.push(e);
        open.set(key, stack);
      } else {
        const begin = open.get(key)?.pop();

        if (begin) finish(begin, e, e.args);
      }
    } else if (e.ph === "I" || e.ph === "i" || e.ph === "n") spans.push({ ...e, dur: 0 });
  }

  if (started !== null) first = started;

  // MARK: Group

  const labels = new Map([...processes.values()].map((p) => [p.pid, label(p)]));
  const labelOf = (pid) => labels.get(pid) ?? `pid ${pid}`;
  const ms = (us) => us / 1000;

  // Bay's spans: the documents' measures and the engine's events, by name, and the bytes they carried.
  const bay = new Map();
  const bytes = new Map();
  const reactComponents = new Map();
  let reactRenders = 0;
  let reactCommits = 0;
  const frames = new Map();
  const input = new Map();
  const slowInteractions = [];
  const longFrames = [];
  const gc = new Map();
  const ipc = new Map();

  for (const s of spans) {
    const name = s.name === "performance.measure" ? (s.args?.measureName ?? s.name) : s.name;

    if (name?.startsWith("Bay.")) {
      // A measure's detail is the JSON its document gave it.
      const text = s.args?.detail ?? s.args?.data?.detail;
      const detail = v.is(v.string(), text) ? safeJson(text) : null;
      const engine = s.cat?.split(",").includes("browser");
      const key = engine ? `${name} [engine]` : name;

      if (s.dur > 0 || !engine) {
        let list = bay.get(key);

        if (!list) bay.set(key, (list = []));
        list.push(ms(s.dur ?? 0));
      }

      const size = detail?.bytes ?? detail?.sent ?? s.args?.bytes;

      if (v.is(v.number(), size)) bump(bytes, key, size + (detail?.received ?? 0));

      if (name === "Bay.react commit" && detail) {
        reactCommits++;
        reactRenders += detail.renders ?? 0;

        for (const part of String(detail.components ?? "").split(",")) {
          const at = part.lastIndexOf(":");

          if (at > 0) bump(reactComponents, part.slice(0, at), Number(part.slice(at + 1)));
        }
      }

      continue;
    }

    // Frames: the compositor's account of each, presented or dropped.
    if (s.name === "PipelineReporter") {
      const state = (s.args?.frame_reporter ?? s.args?.chrome_frame_reporter)?.state;

      if (state && state !== "STATE_NO_UPDATE_DESIRED") {
        let f = frames.get(s.pid);

        if (!f) frames.set(s.pid, (f = { presented: 0, partial: 0, dropped: 0, durations: [] }));

        if (state === "STATE_DROPPED") f.dropped++;
        else if (state === "STATE_PRESENTED_PARTIAL") f.partial++;
        else f.presented++;

        if (s.dur > 0) f.durations.push(ms(s.dur));
      }

      continue;
    }

    // Long animation frames: a frame's work past 50 ms, with the scripts that took it.
    if (s.name === "AnimationFrame" && s.dur > LONG_TASK_MS * 1000) {
      longFrames.push({ process: labelOf(s.pid), ms: round(ms(s.dur)), at: round(ms(s.ts - first) / 1000, 2) });

      continue;
    }

    // Input: from the event to the next frame after its handlers.
    if (s.name === "EventTiming") {
      const d = s.args?.data;

      if (d?.type) {
        const duration = d.duration ?? ms(s.dur ?? 0);
        let list = input.get(d.type);

        if (!list) input.set(d.type, (list = []));
        list.push(duration);

        if (duration >= 100) slowInteractions.push({ type: d.type, ms: round(duration), process: labelOf(s.pid), at: round(ms(s.ts - first) / 1000, 2) });
      }

      continue;
    }

    if (/^(MajorGC|MinorGC|BlinkGC\.AtomicPhase|V8\.GC_MARK_COMPACTOR|V8\.GCScavenger)$/.test(s.name) && s.dur > 0) {
      bump(gc, `${labelOf(s.pid)}  ${s.name}`, ms(s.dur));

      continue;
    }

    // Mojo messages each process received, by interface (Bay's are bay.mojom.*).
    if (s.cat?.includes("mojom") && s.dur > 0 && s.name.startsWith("Receive ")) {
      const info = s.args?.chrome_mojo_event_info;
      const key = `${labelOf(s.pid)}  ${info?.mojo_interface_tag ?? s.name.replace(/^Receive /, "")}${s.name.endsWith("reply") ? " (reply)" : ""}`;
      let entry = ipc.get(key);

      if (!entry) ipc.set(key, (entry = []));
      entry.push(ms(s.dur));
    }
  }

  // Each process's main threads: how busy, and their long tasks.
  const mainThreads = [];
  const longTasks = [];

  for (const [thread, list] of tasks) {
    const name = threads.get(thread) ?? "";

    if (!MAIN_THREADS.test(name)) continue;
    const pid = Number(thread.split(":")[0]);
    // Nested toplevel events are parts of an outer task.
    const sorted = list.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    let end = -Infinity;
    const outer = [];

    for (const task of sorted) {
      if (task[0] >= end) {
        outer.push(task);
        end = task[1];
      }
    }

    const long = outer.filter(([s, e]) => e - s >= LONG_TASK_MS * 1000);
    mainThreads.push({
      process: labelOf(pid),
      thread: name,
      busyMs: round(ms(union(outer))),
      tasks: outer.length,
      longTasks: long.length,
      longestMs: round(ms(Math.max(0, ...outer.map(([s, e]) => e - s)))),
    });

    for (const [s, e, task] of long) longTasks.push({ process: labelOf(pid), thread: name, ms: round(ms(e - s)), at: round(ms(s - first) / 1000, 2), task });
  }

  mainThreads.sort((a, b) => b.busyMs - a.busyMs);
  longTasks.sort((a, b) => b.ms - a.ms);
  const javascript = sampleTimes(profiles, top);
  const seconds = Number.isFinite(first) ? round((last - first) / 1e6, 2) : 0;
  const mb = (n) => round(n / 1048576);

  const numbers = {
    seconds,
    bay: Object.fromEntries(
      [...bay]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, values]) => {
          const entry = stats(values);

          // What the spans carried, for those that say.
          if (bytes.has(name)) entry.kb = round(bytes.get(name) / 1024);

          return [name, entry];
        }),
    ),
    mainThreads: Object.fromEntries(mainThreads.map((t) => [`${t.process}  ${t.thread}`, t])),
    javascript: Object.fromEntries([...javascript].map(([pid, js]) => [labelOf(pid), js])),
    frames: Object.fromEntries(
      [...frames].map(([pid, f]) => [labelOf(pid), { presented: f.presented, partial: f.partial, dropped: f.dropped, ...stats(f.durations) }]),
    ),
    input: Object.fromEntries([...input].map(([type, values]) => [type, stats(values)])),
    react: { commits: reactCommits, renders: reactRenders, components: Object.fromEntries([...reactComponents].sort((a, b) => b[1] - a[1]).slice(0, top * 2)) },
    gc: Object.fromEntries([...gc].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, round(v)])),
    ipc: Object.fromEntries(
      [...ipc]
        .map(([k, v]) => [k, stats(v)])
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, top),
    ),
    memory: Object.fromEntries([...memory].map(([pid, m]) => [labelOf(pid), Object.fromEntries(Object.entries(m).map(([k, v]) => [`${k}MB`, mb(v)]))])),
  };

  return {
    numbers,
    longTasks: longTasks.slice(0, top),
    longFrames: longFrames.sort((a, b) => b.ms - a.ms).slice(0, top),
    slowInteractions,
    processes: [...processes.values()].map((p) => ({ pid: p.pid, label: labelOf(p.pid), urls: [...p.urls] })),
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// MARK: Text

const table = (rows, columns) => {
  if (!rows.length) return "  (none)";
  const cells = rows.map((row) => columns.map((c) => String(row[c] ?? "")));
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length)));
  const line = (r) => `  ${r.map((cell, i) => (i ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join("  ")}`;

  return [line(columns), ...cells.map(line)].join("\n");
};

export function formatReport(report, file) {
  const n = report.numbers;
  const out = [`${file}: ${n.seconds} s`];
  const section = (title, body) => out.push("", title, body);

  section(
    "Processes:",
    table(
      report.processes.map((p) => ({ pid: p.pid, process: p.label, documents: p.urls.slice(0, 3).join(" ") })),
      ["pid", "process", "documents"],
    ),
  );
  section(
    "Main threads (busy ms, and tasks of 50 ms or more):",
    table(
      Object.values(n.mainThreads).map((t) => ({
        thread: `${t.process}  ${t.thread}`,
        busy: t.busyMs,
        tasks: t.tasks,
        long: t.longTasks,
        longest: t.longestMs,
      })),
      ["thread", "busy", "tasks", "long", "longest"],
    ),
  );
  section(
    "Bay's spans (ms; [engine] is the browser process's relay, the rest the documents'):",
    table(
      Object.entries(n.bay)
        .sort((a, b) => b[1].total - a[1].total)
        .map(([name, s]) => ({ span: name, count: s.count, total: s.total, p50: s.p50, p95: s.p95, max: s.max, kb: s.kb ?? "" })),
      ["span", "count", "total", "p50", "p95", "max", "kb"],
    ),
  );

  for (const [process, js] of Object.entries(n.javascript)) {
    if (js.busy < 1) continue;
    section(`JavaScript in ${process}: ${js.busy} ms sampled`, `  by layer:\n${js.layers.map(([k, v]) => `    ${String(v).padStart(8)}  ${k}`).join("\n")}`);
    out.push(`  self time:\n${js.self.map(([k, v]) => `    ${String(v).padStart(8)}  ${k}`).join("\n")}`);
    out.push(
      `  total time, with what it called:\n${js.total
        .filter(([k]) => !/^\((root|program)\)/.test(k))
        .slice(0, 25)
        .map(([k, v]) => `    ${String(v).padStart(8)}  ${k}`)
        .join("\n")}`,
    );
  }

  if (n.react.commits)
    section(
      `React: ${n.react.commits} commits, ${n.react.renders} component renders. Most rendered:`,
      Object.entries(n.react.components)
        .slice(0, 25)
        .map(([k, v]) => `  ${String(v).padStart(6)}  ${k}`)
        .join("\n"),
    );
  section(
    "Frames (the compositor's: presented, partly presented, dropped; ms from start to presentation):",
    table(
      Object.entries(n.frames).map(([process, f]) => ({
        process,
        presented: f.presented,
        partial: f.partial,
        dropped: f.dropped,
        p50: f.p50,
        p95: f.p95,
        max: f.max,
      })),
      ["process", "presented", "partial", "dropped", "p50", "p95", "max"],
    ),
  );
  section(
    "Input (ms from the event to the frame after its handlers):",
    table(
      Object.entries(n.input).map(([type, s]) => ({ type, count: s.count, p50: s.p50, p95: s.p95, max: s.max })),
      ["type", "count", "p50", "p95", "max"],
    ),
  );

  if (report.slowInteractions.length)
    section("Interactions of 100 ms or more (s into the trace):", table(report.slowInteractions, ["at", "type", "ms", "process"]));
  section("Longest tasks (s into the trace):", table(report.longTasks, ["at", "ms", "process", "thread", "task"]));

  if (report.longFrames.length) section("Long animation frames:", table(report.longFrames, ["at", "ms", "process"]));
  section(
    "Garbage collection (ms):",
    Object.entries(n.gc)
      .map(([k, v]) => `  ${String(v).padStart(8)}  ${k}`)
      .join("\n") || "  (none)",
  );
  section(
    "IPC received (Mojo messages, by total ms):",
    table(
      Object.entries(n.ipc).map(([message, s]) => ({ message, count: s.count, total: s.total, p95: s.p95, max: s.max })),
      ["message", "count", "total", "p95", "max"],
    ),
  );
  section(
    "Memory (peak MB):",
    table(
      Object.entries(n.memory).map(([process, m]) => ({ process, ...m })),
      ["process", "footprintMB", "v8MB", "blinkMB", "mallocMB", "partitionMB"],
    ),
  );

  return out.join("\n");
}

// MARK: Comparing

const change = (before, after) => (before ? round(((after - before) / before) * 100) : after ? Infinity : 0);

/** What moved between two reports' numbers: Bay's spans, main threads, frames, input, JavaScript and memory. */
export function compareReports(before, after) {
  const rows = [];

  const add = (group, name, metric, a, b) => {
    if (a === undefined && b === undefined) return;
    rows.push({ group, name, metric, before: a ?? 0, after: b ?? 0, change: change(a ?? 0, b ?? 0) });
  };

  for (const name of new Set([...Object.keys(before.bay ?? {}), ...Object.keys(after.bay ?? {})])) {
    const [a, b] = [before.bay?.[name], after.bay?.[name]];

    for (const metric of ["p50", "p95", "total", "count"]) add("bay", name, metric, a?.[metric], b?.[metric]);
  }

  for (const name of new Set([...Object.keys(before.mainThreads ?? {}), ...Object.keys(after.mainThreads ?? {})]))
    for (const metric of ["busyMs", "longTasks", "longestMs"])
      add("thread", name, metric, before.mainThreads?.[name]?.[metric], after.mainThreads?.[name]?.[metric]);

  for (const name of new Set([...Object.keys(before.javascript ?? {}), ...Object.keys(after.javascript ?? {})]))
    add("javascript", name, "busy", before.javascript?.[name]?.busy, after.javascript?.[name]?.busy);

  for (const name of new Set([...Object.keys(before.frames ?? {}), ...Object.keys(after.frames ?? {})]))
    for (const metric of ["dropped", "p95"]) add("frames", name, metric, before.frames?.[name]?.[metric], after.frames?.[name]?.[metric]);

  for (const name of new Set([...Object.keys(before.input ?? {}), ...Object.keys(after.input ?? {})]))
    for (const metric of ["p50", "p95", "max"]) add("input", name, metric, before.input?.[name]?.[metric], after.input?.[name]?.[metric]);

  for (const name of new Set([...Object.keys(before.memory ?? {}), ...Object.keys(after.memory ?? {})]))
    add("memory", name, "footprintMB", before.memory?.[name]?.footprintMB, after.memory?.[name]?.footprintMB);

  add("react", "commits", "count", before.react?.commits, after.react?.commits);
  add("react", "renders", "count", before.react?.renders, after.react?.renders);

  return { seconds: [before.seconds, after.seconds], rows };
}

export function formatComparison({ seconds, rows }) {
  // Moves smaller than 10% are within a recording's noise.
  const moved = rows.filter((r) => Math.abs(r.change) >= 10 && Math.max(r.before, r.after) > 0.5);
  const faster = moved.filter((r) => r.change < 0).sort((a, b) => a.change - b.change);
  const slower = moved.filter((r) => r.change > 0).sort((a, b) => b.change - a.change);

  const show = (list) =>
    table(
      list.map((r) => ({ ...r, change: Number.isFinite(r.change) ? `${r.change > 0 ? "+" : ""}${r.change}%` : "new" })),
      ["group", "name", "metric", "before", "after", "change"],
    );

  return [
    `Recordings of ${seconds[0]} s and ${seconds[1]} s: counts and totals compare only for the same steps.`,
    "",
    "Better (down 10% or more):",
    show(faster),
    "",
    "Worse (up 10% or more):",
    show(slower),
  ].join("\n");
}
