// Opt-in probe for the JS benchmark (apps/browser/scripts/perf/js-bench.mjs). It turns on only in an
// isolated instance (BAY_DATA_DIR or BAY_BACKGROUND) whose data folder holds a `perf-probe`
// file; otherwise it installs nothing.
// index.js imports it first, so React's renderer finds the hook below when it loads.
//
// With it on: React commits, component renders and mounts, host view updates, store updates and the time
// their subscribers take, native→JS calls (events, timers) with their time, timer callbacks and document
// writes, all readable through `globalThis.nnPerf` from the dev harness.
import * as v from "valibot";

// Any value the app can hand the probe: React fiber fields, store states, native module payloads.
type ProbeValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | symbol
  | ProbeValue[]
  | { [key: string]: ProbeValue }
  | ((...args: never[]) => ProbeValue);

type EventListener = (...args: ProbeValue[]) => ProbeValue;

const isListenerFn = (value: ProbeValue): value is EventListener => v.is(v.function_(), value);

type FiberComponentType =
  | string
  | ((...args: never[]) => ProbeValue)
  | { displayName?: string; render?: FiberComponentType; type?: FiberComponentType }
  | null
  | undefined;

type Fiber = {
  tag: number;
  flags: number;
  type: FiberComponentType;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  memoizedProps: Record<string, ProbeValue> | null;
  memoizedState: ProbeValue;
  dependencies: { firstContext: ContextItem | null } | null;
  stateNode: ProbeValue;
  // Set by React's profiling build only (the bench bundles it with --profiling).
  selfBaseDuration?: number;
  actualDuration?: number;
};

type ContextItem = { context: { displayName?: string }; memoizedValue: ProbeValue; next: ContextItem | null };

type Hook = { memoizedState: ProbeValue; queue: ProbeValue; next: Hook | null };

type Counter = Record<string, number>;

// This runs before anything has imported expo-modules-core, and the legacy bridge installs `expo` ahead of the bundle
// only when its runtime exists by then: install it as expo-modules-core's ensureNativeModulesAreInstalled does, or the
// probe stays off in some launches.
type ExpoModules = {
  BayApp?: { systemInfo?: () => ProbeValue };
  BayShell?: {
    readDocument?: (name: string) => ProbeValue;
    writeDocument?: (name: string, contents: string) => ProbeValue;
  };
};

// SAFETY: expo-modules-core registers `expo` on the global ahead of the bundle only when its runtime exists;
// absent on other launches, and the guard handles that.
if (!(globalThis as { expo?: { modules?: ExpoModules } }).expo) {
  try {
    // SAFETY: require("react-native") returns the same module namespace as the static import; require is untyped.
    const { TurboModuleRegistry } = require("react-native") as typeof import("react-native");
    // SAFETY: ExpoModulesCore, when present, is Expo's native modules module and exposes installModules().
    (TurboModuleRegistry.get("ExpoModulesCore") as { installModules?: () => void } | null)?.installModules?.();
  } catch {}
}

// SAFETY: expo-modules-core registers BayApp and BayShell on the global only in builds that ship them;
// both are optional and every use below is guarded.
const modules = (globalThis as { expo?: { modules?: ExpoModules } }).expo?.modules;
const shell = modules?.BayShell;

// The file's contents name optional (slower) probes: "selectors" times every store selector by call site;
// "renders" says why each component rendered (props, state, context, or nothing: a wasted render).
const probeOptions = (() => {
  try {
    const parsed = v.safeParse(v.object({ isolatedInstance: v.optional(v.boolean()) }), modules?.BayApp?.systemInfo?.());

    if (!parsed.success || !parsed.output.isolatedInstance) return null;
    const readDocument = shell?.readDocument;

    if (!readDocument) return null;
    const file = readDocument("perf-probe");

    return v.is(v.string(), file) ? file : null;
  } catch {
    return null;
  }
})();

export const perfProbeEnabled = probeOptions !== null;

// What the probe counts, as nnPerf.revision; js-bench stamps it into its reports and `compare` warns when two differ.
// Bump it whenever a change moves the numbers (a new kind of task timed, a counter redefined).
//   1  before 6232fa43 (0.2.21 and older): Expo module events (JSI) weren't timed as tasks
//   2  6232fa43: module events timed as module:<event> tasks, counted in taskMs; commitTasks
export const PERF_PROBE_REVISION = 2;
const rendersProbe = !!probeOptions?.includes("renders");
// "listeners" also times each store listener by the functions that subscribed it.
const listenersProbe = !!probeOptions?.includes("listeners");

const now = () => performance.now();
const bump = (c: Counter, key: string, by = 1) => void (c[key] = (c[key] ?? 0) + by);

type ProbeStats = {
  since: number;
  commits: number;
  commitTimes: number[];
  commitTaskLog: string[];
  renders: Counter;
  mounts: Counter;
  hostUpdates: number;
  walkMs: number;
  storeUpdates: Counter;
  storeKeys: Counter;
  listenerCalls: Counter;
  listenerMs: Counter;
  listenerSiteCalls: Counter;
  listenerSiteMs: Counter;
  tasks: Counter;
  taskMs: Counter;
  taskLog: [string, number][];
  commitTasks: Counter;
  timers: Counter;
  timerMs: Counter;
  selectorCalls: Counter;
  selectorMs: Counter;
  writes: Counter;
  writeBytes: Counter;
  writeMs: Counter;
  wasted: Counter;
  wastedMs: Counter;
  unstable: Counter;
  unstableMs: Counter;
  renderMs: Counter;
  causes: Record<string, Counter>;
  origins: Counter;
  commitMs: number;
};

function fresh(): ProbeStats {
  return {
    since: now(),
    commits: 0,
    commitTimes: [],
    // The task of each commit in commitTimes.
    commitTaskLog: [],
    renders: {},
    mounts: {},
    hostUpdates: 0,
    walkMs: 0,
    storeUpdates: {},
    storeKeys: {},
    listenerCalls: {},
    listenerMs: {},
    // With the "listeners" probe: the same, by the store and the function that subscribed.
    listenerSiteCalls: {},
    listenerSiteMs: {},
    tasks: {},
    taskMs: {},
    // When each native→JS task other than a timer started: [label, time].
    taskLog: [],
    // Commits by the task they happened in (a native→JS call, a timer, a native module's event).
    commitTasks: {},
    timers: {},
    timerMs: {},
    selectorCalls: {},
    selectorMs: {},
    writes: {},
    writeBytes: {},
    writeMs: {},
    // With the "renders" probe: per component, renders that changed nothing (wasted), their time, each
    // render's self time, and what changed (props:<key> real change, fn:<key> new function, obj:<key> new
    // but shallow-equal object, state, state~ new but shallow-equal state, context:<name>).
    wasted: {},
    wastedMs: {},
    unstable: {},
    unstableMs: {},
    renderMs: {},
    causes: {},
    // Components whose own state or context changed with their props unchanged: where an update starts.
    origins: {},
    commitMs: 0,
  };
}

let stats = fresh();
const marks: Record<string, number> = {};
const startedAt = now();
const startup: [task: string, at: number, ms: number][] = [];
const roots = new Set<{ current: Fiber }>();
let firstCommit = 0;
// The native→JS task running now (bridge call, timer callback or native module event), for commitTasks.
let task: string | null = null;

type FiberTypeObject = { displayName?: string; render?: FiberComponentType; type?: FiberComponentType };

const isFiberTypeObject = (value: FiberComponentType): value is FiberTypeObject =>
  value !== null && value !== undefined && !v.is(v.string(), value) && !v.is(v.function_(), value);

function nameOf(type: FiberComponentType): string {
  if (v.is(v.string(), type)) return type;

  if (v.is(v.function_(), type)) return type.name || "Anonymous";

  if (!isFiberTypeObject(type)) return String(type ?? "Anonymous");

  if (type.displayName) return type.displayName;

  if (type.render) return nameOf(type.render);

  if (type.type) return nameOf(type.type);

  return "Anonymous";
}

const COMPONENT_TAGS = new Set([0, 1, 11, 15]);
const PERFORMED_WORK = 1;
const UPDATE = 4;
const HOST_COMPONENT = 5;

// Walks only the part of the tree React reconciled: a fiber whose child list is the one it had before
// wasn't visited this commit (React's DevTools skips the same way).
function walk(fiber: Fiber) {
  if (fiber.alternate && fiber.child === fiber.alternate.child) return;
  for (let c = fiber.child; c; c = c.sibling) {
    if (COMPONENT_TAGS.has(c.tag)) {
      if (!c.alternate) bump(stats.mounts, nameOf(c.type));
      else if (c.flags & PERFORMED_WORK) {
        bump(stats.renders, nameOf(c.type));
        if (rendersProbe) classify(c, c.alternate);
      }
    } else if (c.tag === HOST_COMPONENT && c.alternate && c.flags & UPDATE) stats.hostUpdates++;
    walk(c);
  }
}

const isObject = (value: ProbeValue): value is Record<string, ProbeValue> => v.is(v.object({}), value);

function shallowEqual(a: ProbeValue, b: ProbeValue) {
  if (Object.is(a, b)) return true;

  if (!isObject(a) || !isObject(b)) return false;
  const ka = Object.keys(a);

  if (ka.length !== Object.keys(b).length) return false;

  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && Object.is(a[k], b[k]));
}

// Why a component rendered this commit, against what it rendered with last time (its alternate).
function classify(fiber: Fiber, before: Fiber) {
  const name = nameOf(fiber.type);
  const causes: string[] = [];
  const props = fiber.memoizedProps ?? {};
  const prev = before.memoizedProps ?? {};
  let propsChanged = false;
  let realProps = false;
  if (props !== prev) {
    for (const key of new Set([...Object.keys(props), ...Object.keys(prev)])) {
      const a = props[key];
      const b = prev[key];

      if (Object.is(a, b)) continue;
      propsChanged = true;

      if (v.is(v.function_(), a) && v.is(v.function_(), b)) causes.push(`fn:${key}`);
      else if (key !== "children" && isObject(a) && isObject(b) && shallowEqual(a, b)) causes.push(`obj:${key}`);
      else {
        realProps = true;
        causes.push(`props:${key}`);
      }
    }
  }
  let stateChanged = false;
  if (fiber.tag === 1) {
    if (!shallowEqual(fiber.memoizedState, before.memoizedState)) {
      stateChanged = true;
      causes.push("state");
    }
  } else {
    // Only hooks with an update queue hold state (useState, useReducer, useSyncExternalStore: zustand
    // selectors); memo, ref and effect hooks follow from props and state.
    // SAFETY: function components with state hooks keep the hooks linked list in memoizedState (React fiber
    // layout, stable across the React versions this runs against); null when the component has no hooks.
    let h = fiber.memoizedState as Hook | null;
    // SAFETY: same linked-list layout for the alternate fiber (the previous commit's tree).
    let o = before.memoizedState as Hook | null;

    for (; h && o; h = h.next, o = o.next) {
      if (h.queue == null || Object.is(h.memoizedState, o.memoizedState)) continue;
      stateChanged = true;
      causes.push(shallowEqual(h.memoizedState, o.memoizedState) ? "state~" : "state");
    }
  }
  let contextChanged = false;
  let ci = fiber.dependencies?.firstContext ?? null;
  let co = before.dependencies?.firstContext ?? null;
  for (; ci; ci = ci.next, co = co?.next ?? null) {
    if (co && Object.is(ci.memoizedValue, co.memoizedValue)) continue;
    contextChanged = true;
    causes.push(`context:${ci.context.displayName ?? "?"}`);
  }
  const ms = fiber.selfBaseDuration ?? 0;
  bump(stats.renderMs, name, ms);
  const counter = (stats.causes[name] ??= {});
  if (!propsChanged && !stateChanged && !contextChanged) {
    bump(stats.wasted, name);
    bump(stats.wastedMs, name, ms);
    bump(counter, "wasted");
  } else {
    if (!propsChanged) bump(stats.origins, name);
    // Only new functions or new-but-equal objects: stable props (memo, callbacks) would have skipped it.
    else if (!realProps && !stateChanged && !contextChanged) {
      bump(stats.unstable, name);
      bump(stats.unstableMs, name, ms);
    }
    for (const cause of new Set(causes)) bump(counter, cause);
  }
}

function installReactHook() {
  let ids = 0;
  // SAFETY: the hook slot is React DevTools' documented global; installing it here is the probe's purpose.
  (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: () => ++ids,
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      const t = now();
      firstCommit ||= Date.now();
      roots.add(root);
      stats.commits++;
      bump(stats.commitTasks, task ?? "other");
      if (stats.commitTimes.length < 5000) {
        stats.commitTimes.push(t);
        stats.commitTaskLog.push(task ?? "other");
      }
      try {
        walk(root.current);
      } catch {}
      stats.commitMs += root.current.actualDuration ?? 0;
      stats.walkMs += now() - t;
    },
  };
}

let traceTimers = false;

const callers = (stack: string | undefined, depth = 4) =>
  (stack ?? "")
    .split("\n")
    .slice(2, 2 + depth)
    .map((line) => /at (\S+)/.exec(line)?.[1] ?? "?")
    .join(" < ");

function wrapTimers() {
  // Times a callback and reports it as `name:label`; preserves the native timer contract (id out).
  const withTiming = (name: string, callback: Function) => {
      let label = `${name}:${callback.name || "anonymous"}`;

      // With nnPerf.traceTimers on, anonymous callbacks are named by the functions that scheduled them.
      if (traceTimers && !callback.name) label += ` <${callers(new Error().stack)}>`;

    return function (this: ProbeValue, ...args: ProbeValue[]) {
          const t = now();
          const outer = task;

          task = label;

          try {
        return callback.apply(this, args);
          } finally {
            task = outer;
            bump(stats.timers, label);
            bump(stats.timerMs, label, now() - t);
          }
    };
  };

  const timeout = globalThis.setTimeout;

  if (timeout) {
    const wrapped = function (this: ProbeValue, handler?: TimerHandler, timeoutMs?: number, ...args: never[]): number {
      if (handler === undefined || v.is(v.string(), handler)) {
        // SAFETY: a non-function (or missing) handler goes straight to the native timer, exactly as without the probe.
        return timeout.apply(this, [handler, timeoutMs, ...args] as never);
      }

      return timeout.call(this, withTiming("setTimeout", handler), timeoutMs, ...args);
    };

    Object.assign(globalThis, { setTimeout: wrapped });
  }

  const interval = globalThis.setInterval;

  if (interval) {
    const wrapped = function (this: ProbeValue, handler?: TimerHandler, timeoutMs?: number, ...args: never[]): number {
      if (handler === undefined || v.is(v.string(), handler)) {
        // SAFETY: a non-function (or missing) handler goes straight to the native timer, exactly as without the probe.
        return interval.apply(this, [handler, timeoutMs, ...args] as never);
      }

      return interval.call(this, withTiming("setInterval", handler), timeoutMs, ...args);
    };

    Object.assign(globalThis, { setInterval: wrapped });
  }

  const raf = globalThis.requestAnimationFrame;

  if (raf) {
    const wrapped = function (this: ProbeValue, callback: FrameRequestCallback): number {
      const timed: FrameRequestCallback = (time) => {
        task = "requestAnimationFrame:callback";

        try {
          callback(time);
        } finally {
          task = null;
          bump(stats.timers, "requestAnimationFrame");
        }
      };

      return raf.call(this, timed);
    };

    Object.assign(globalThis, { requestAnimationFrame: wrapped });
  }

  // SAFETY: setImmediate is RN/Hermes' own timer, absent from this project's DOM lib; skipped where missing.
  const immediate = Object.getOwnPropertyDescriptor(globalThis, "setImmediate")?.value as
    | ((this: ProbeValue, handler?: Function, ...args: never[]) => number)
    | undefined;

  if (immediate) {
    const wrapped = function (this: ProbeValue, handler?: Function, ...args: never[]): number {
      if (handler === undefined || v.is(v.string(), handler)) {
        // SAFETY: a non-function (or missing) handler goes straight to the native timer, exactly as without the probe.
        return immediate.apply(this, [handler, ...args] as never);
      }

      return immediate.call(this, withTiming("setImmediate", handler), ...args);
    };

    Object.assign(globalThis, { setImmediate: wrapped });
  }
}

// Times each useSyncExternalStore snapshot (a zustand selector), keyed by the hooks and component that
// called it. Stack capture on every render makes this slow; use it to find costly selectors, not to time.
function wrapSelectors() {
  // SAFETY: require("react") returns the same module namespace as the static import; require is untyped.
  const react = require("react") as { useSyncExternalStore: (...a: ProbeValue[]) => ProbeValue };
  const original = react.useSyncExternalStore;
  react.useSyncExternalStore = (subscribe: ProbeValue, getSnapshot: ProbeValue, getServerSnapshot: ProbeValue) => {
    const label = callers(new Error().stack, 4);
    // SAFETY: useSyncExternalStore receives a snapshot function; React calls it on every render.
    const get = getSnapshot as () => ProbeValue;

    const timed = () => {
      const t = now();

      try {
        return get();
      } finally {
        bump(stats.selectorCalls, label);
        bump(stats.selectorMs, label, now() - t);
      }
    };
    return original(subscribe, timed, getServerSnapshot);
  };
}

// Every native→JS call (events, timers, callbacks) goes through the bridge queue; time each one.
function wrapBridge() {
  // SAFETY: the RN bridge queue exists only in bridge-built launches; guarded below.
  const queue = (globalThis as { __fbBatchedBridge?: Record<string, (...a: ProbeValue[]) => ProbeValue> }).__fbBatchedBridge;

  if (!queue) return;

  const wrap = (method: string, label: (args: ProbeValue[]) => string) => {
    const original = queue[method];

    if (original === undefined) return;

    queue[method] = (...args: ProbeValue[]): ProbeValue => {
      const t = now();
      const key = label(args);
      task = key;
      if (key !== "JSTimers.callTimers" && stats.taskLog.length < 5000) stats.taskLog.push([key, t]);
      try {
        return original.apply(queue, args);
      } finally {
        task = null;
        const end = now();
        bump(stats.tasks, key);
        bump(stats.taskMs, key, end - t);
        // Until the first window is up: when each task ran (ms from the bundle's start) and for how long.
        if (!marks.firstWindow && startup.length < 1000) startup.push([key, Math.round(t - startedAt), Math.round((end - t) * 10) / 10]);
      }
    };
  };
  wrap("callFunctionReturnFlushedQueue", ([module, method, args]) => {
    if (module === "RCTEventEmitter" && Array.isArray(args)) return `event:${String(args[1])}`;
    if (module === "RCTDeviceEventEmitter" && Array.isArray(args)) return `device:${String(args[0])}`;
    return `${String(module)}.${String(method)}`;
  });
  wrap("invokeCallbackAndReturnFlushedQueue", () => "callback");
}

// Native modules' events (Expo's, through JSI) don't go through the bridge queue: time each listener call as a
// `module:<event>` task. A listener an event of the JS side's own runs inside its task and isn't counted again.
function wrapModuleEvents() {
  // SAFETY: expo-modules-core installs expo on the global in builds that ship it; EventEmitter's prototype
  // carries the add/remove listener pair this wraps. Absent elsewhere; guarded below.
  const expo = Object.getOwnPropertyDescriptor(globalThis, "expo")?.value as { EventEmitter?: { prototype?: Record<string, ProbeValue> } } | undefined;
  const proto = expo?.EventEmitter?.prototype;

  // SAFETY: addListener is Expo EventEmitter's method; its first argument is the event name.
  const add = proto?.addListener as ((this: ProbeValue, name: string, listener: EventListener) => ProbeValue) | undefined;
  // SAFETY: removeListener is Expo EventEmitter's method; its first argument is the event name.
  const remove = proto?.removeListener as ((this: ProbeValue, name: string, listener: ProbeValue) => ProbeValue) | undefined;

  if (!proto || !isListenerFn(add) || !isListenerFn(remove)) return;
  // Per listener and event, so removeListener finds what addListener added.
  const wrapped = new WeakMap<object, Map<string, EventListener>>();
  proto.addListener = function (this: ProbeValue, name: string, listener: ProbeValue): ProbeValue {
    if (!isListenerFn(listener)) return add.call(this, name, listener);
    const key = `module:${name}`;
    const byName = wrapped.get(listener) ?? new Map<string, EventListener>();
    wrapped.set(listener, byName);

    const timed =
      byName.get(name) ??
      function (this: ProbeValue, ...args: ProbeValue[]): ProbeValue {
        if (task !== null) return listener.apply(this, args);
        const t = now();
        task = key;
        if (stats.taskLog.length < 5000) stats.taskLog.push([key, t]);
        try {
          return listener.apply(this, args);
        } finally {
          task = null;
          bump(stats.tasks, key);
          bump(stats.taskMs, key, now() - t);
        }
      };

    byName.set(name, timed);

    return add.call(this, name, timed);
  };

  proto.removeListener = function (this: ProbeValue, name: string, listener: ProbeValue): ProbeValue {
    return remove.call(this, name, (isListenerFn(listener) && wrapped.get(listener)?.get(name)) || listener);
  };
}

function wrapWrites() {
  const target = shell;
  const original = target?.writeDocument;

  if (!target || !original) return;

  try {
    target.writeDocument = (name: string, contents: string) => {
      const t = now();

      try {
        return original(name, contents);
      } finally {
        const key = String(name);
        bump(stats.writes, key);
        bump(stats.writeBytes, key, contents.length);
        bump(stats.writeMs, key, now() - t);
      }
    };
  } catch {}
}

// Counts a store's updates (by top-level key) and times every subscriber it notifies.
export function probeStore<S>(name: string, store: { subscribe(listener: (s: S, prev: S) => void): () => void }) {
  if (!perfProbeEnabled) return;
  const subscribe = store.subscribe;
  store.subscribe = (listener) => {
    const site = listenersProbe ? `${name} ${callers(new Error().stack, 3)}` : "";
    return subscribe((s, prev) => {
      const t = now();
      try {
        listener(s, prev);
      } finally {
        const ms = now() - t;
        bump(stats.listenerCalls, name);
        bump(stats.listenerMs, name, ms);
        if (site) {
          bump(stats.listenerSiteCalls, site);
          bump(stats.listenerSiteMs, site, ms);
        }
      }
    });
  };

  subscribe((s, prev) => {
    bump(stats.storeUpdates, name);

    for (const key in s) if (s[key] !== prev[key]) bump(stats.storeKeys, `${name}.${key}`);
  });
}

export function perfMark(name: string) {
  if (perfProbeEnabled && !marks[name]) marks[name] = Date.now();
}

function findFibers(name: string, limit = 50): Fiber[] {
  const out: Fiber[] = [];
  const visit = (f: Fiber | null) => {
    for (let c = f; c && out.length < limit; c = c.sibling) {
      if (COMPONENT_TAGS.has(c.tag) && nameOf(c.type) === name) out.push(c);
      visit(c.child);
    }
  };
  for (const root of roots) visit(root.current);
  return out;
}

// Hermes' sampling profiler (macos/Bay-macOS/HermesProfiler.mm): js-bench --cpuprofile 1 starts it before a scenario
// and writes a Chrome trace of the JS thread after it. Null where the app has no profiler (an older build).
type HermesProfiler = { start(hz: number): boolean; stop(name: string): string | null };
const cpuProfile = {
  start(hz = 1000): boolean {
    return !!profiler()?.start(hz);
  },
  /** Writes the samples since `start` to `name` in the data folder; the file's path. */
  stop(name: string): string | null {
    return profiler()?.stop(name) ?? null;
  },
};

// SAFETY: require("react-native") returns the same module namespace as the static import; NNHermesProfiler
// exists only in builds with the sampling profiler, hence optional and guarded at the call sites.
const profiler = (): HermesProfiler | undefined =>
  (require("react-native") as { NativeModules?: { NNHermesProfiler?: HermesProfiler } }).NativeModules?.NNHermesProfiler;

if (perfProbeEnabled) {
  marks.bundleStart = Date.now();
  installReactHook();
  wrapTimers();
  wrapBridge();
  wrapModuleEvents();
  wrapWrites();

  if (probeOptions?.includes("selectors")) wrapSelectors();
  // SAFETY: nnPerf is the probe's own dev-harness surface, read only by the benchmark tooling.
  (globalThis as { nnPerf?: unknown }).nnPerf = {
    revision: PERF_PROBE_REVISION,
    marks,
    startup,
    get firstCommit() {
      return firstCommit;
    },
    reset: () => void (stats = fresh()),
    set traceTimers(on: boolean) {
      traceTimers = on;
    },
    read: () => ({ ...stats, elapsed: now() - stats.since }),
    now,
    batch: (fn: () => void) => (require("@bay/platform") as typeof import("@bay/platform")).batchedUpdates(fn),
    findFibers,
    nameOf,
    cpuProfile,
  };
}
