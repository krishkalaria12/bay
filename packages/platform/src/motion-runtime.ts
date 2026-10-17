/** JavaScript animation driver for desktop RNW, independent of native Reanimated. */
export type Completion = (finished?: boolean, current?: number) => void;
export type TimingConfig = { duration?: number; easing?: (t: number) => number; reduceMotion?: string };
export type SpringConfig = TimingConfig & { stiffness?: number; damping?: number; mass?: number; velocity?: number; overshootClamping?: boolean; restDisplacementThreshold?: number; restSpeedThreshold?: number };
export type SharedValue<T> = {
  value: T;
  get(): T;
  set(value: T | ((current: T) => T)): void;
  addListener(id: number, listener: (value: T) => void): void;
  removeListener(id: number): void;
  modify(modifier?: (value: T) => T, forceUpdate?: boolean): void;
};
type Animation = {
  kind: "timing" | "spring" | "delay" | "sequence" | "repeat";
  to?: number;
  config?: SpringConfig;
  callback?: Completion;
  children?: Animation[];
  delay?: number;
  count?: number;
  reverse?: boolean;
};
const animations = new WeakSet<object>();
const descriptor = (animation: Animation): number => {
  animations.add(animation);
  return animation as unknown as number;
};
const isAnimation = (value: unknown): value is Animation => typeof value === "object" && value !== null && animations.has(value);
const child = (value: number): Animation => isAnimation(value) ? value : { kind: "timing", to: value, config: { duration: 0 } };
export const withTiming = (to: number, config: TimingConfig = {}, callback?: Completion): number => descriptor({ kind: "timing", to, config, callback });
export const withSpring = (to: number, config: SpringConfig = {}, callback?: Completion): number => descriptor({ kind: "spring", to, config, callback });
export const withDelay = (delay: number, animation: number): number => descriptor({ kind: "delay", delay, children: [child(animation)] });
export const withSequence = (...values: number[]): number => descriptor({ kind: "sequence", children: values.map(child) });
export const withRepeat = (animation: number, count = 2, reverse = false, callback?: Completion): number => descriptor({ kind: "repeat", count, reverse, children: [child(animation)], callback });

export type FrameClock = { request(callback: (time: number) => void): number; cancel(id: number): void; now(): number; reduced(): boolean };
let clock: FrameClock = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
  now: () => performance.now(),
  reduced: () => false,
};
/** Install the host clock once, or a deterministic clock in tests. */
export function configureMotionClock(value: FrameClock): void { clock = value; }
let collecting: Set<Observable> | null = null;
type Observable = { subscribe(listener: () => void): () => void; version(): number };
let revision = 0;
export function collectMotion<T>(read: () => T): { value: T; dependencies: Set<Observable> } {
  const previous = collecting;
  const dependencies = new Set<Observable>();
  collecting = dependencies;
  try { return { value: read(), dependencies }; }
  finally { collecting = previous; }
}

// Each runner owns its cancellation and calls its completion once, including interruption.
function run(animation: Animation, from: number, write: (value: number) => void, done: (finished: boolean) => void): () => void {
  let active = true;
  let frame: number | undefined;
  let cancelChild: (() => void) | undefined;
  let current = from;
  const put = (value: number) => { current = value; write(value); };
  const finish = (finished: boolean) => {
    if (!active) return;
    active = false;
    animation.callback?.(finished, current);
    done(finished);
  };
  const cancel = () => {
    if (!active) return;
    if (frame !== undefined) clock.cancel(frame);
    cancelChild?.();
    finish(false);
  };
  const start = clock.now();
  if (animation.kind === "sequence") {
    const steps = animation.children ?? [];
    let index = 0;
    const next = (finished: boolean) => {
      if (!active) return;
      if (!finished || index >= steps.length) return finish(finished);
      cancelChild = run(steps[index++]!, current, put, next);
    };
    next(true);
  } else if (animation.kind === "repeat") {
    const count = animation.count ?? 2;
    let index = 0;
    const original = animation.children![0]!;
    const next = (finished: boolean) => {
      if (!active) return;
      if (!finished || (count > 0 && index >= count) || (clock.reduced() && index > 0)) return finish(finished);
      const reverse = animation.reverse && index % 2 === 1 && original.to !== undefined;
      if (index > 0 && !animation.reverse) put(from);
      index++;
      // Queue iterations so zero-duration repeats cannot recurse forever.
      frame = clock.request(() => {
        if (active) cancelChild = run(reverse ? { ...original, to: from } : original, current, put, next);
      });
    };
    next(true);
  } else if (animation.kind === "delay") {
    const tick = (time: number) => {
      if (!active) return;
      if (time - start < (animation.delay ?? 0) && !clock.reduced()) frame = clock.request(tick);
      else cancelChild = run(animation.children![0]!, current, put, finish);
    };
    frame = clock.request(tick);
  } else {
    const to = animation.to!;
    const config = animation.config ?? {};
    const reduce = config.reduceMotion === "always" || (config.reduceMotion !== "never" && clock.reduced());
    let previous = start;
    let velocity = config.velocity ?? 0;
    const tick = (time: number) => {
      if (!active) return;
      const elapsed = Math.max(0, time - start);
      if (reduce || config.duration === 0) { put(to); finish(true); return; }
      if (animation.kind === "spring" && config.duration === undefined) {
        const stiffness = config.stiffness ?? 100;
        const damping = config.damping ?? 10;
        const mass = Math.max(0.01, config.mass ?? 1);
        // Integrate in small steps after a busy JS frame to keep springs stable.
        let remaining = Math.min(64, Math.max(0, time - previous)) / 1000;
        let position = current;
        while (remaining > 0) {
          const dt = Math.min(remaining, 1 / 240);
          velocity += (-stiffness * (position - to) - damping * velocity) / mass * dt;
          position += velocity * dt;
          remaining -= dt;
        }
        const overshot = config.overshootClamping && (from < to ? position > to : position < to);
        if (overshot || (Math.abs(velocity) < (config.restSpeedThreshold ?? 0.01) && Math.abs(position - to) < (config.restDisplacementThreshold ?? 0.01)) || elapsed > 10000) {
          put(to); finish(true); return;
        }
        put(position);
      } else {
        const progress = Math.min(1, elapsed / Math.max(1, config.duration ?? 300));
        put(from + (to - from) * (config.easing?.(progress) ?? progress));
        if (progress >= 1) { put(to); finish(true); return; }
      }
      previous = time;
      frame = clock.request(tick);
    };
    frame = clock.request(tick);
  }
  return cancel;
}
const cancellers = new WeakMap<object, () => void>();
export function cancelAnimation<T>(value: SharedValue<T>): void {
  const cancel = cancellers.get(value);
  cancellers.delete(value);
  cancel?.();
}
export function makeMutable<T>(initial: T): SharedValue<T> {
  let current = initial;
  let changedAt = 0;
  const listeners = new Map<number, (value: T) => void>();
  const subscribers = new Set<() => void>();
  const read = () => { collecting?.add(observable); return current; };
  const write = (value: T) => {
    if (Object.is(current, value)) return;
    current = value;
    changedAt = ++revision;
    for (const listener of [...listeners.values()]) listener(value);
    for (const listener of [...subscribers]) listener();
  };
  const observable: SharedValue<T> & Observable = {
    get value() { return read(); },
    set value(value: T) { observable.set(value); },
    get: read,
    set(value) {
      cancelAnimation(observable);
      const next = typeof value === "function" ? (value as (v: T) => T)(current) : value;
      if (isAnimation(next)) {
        if (typeof current !== "number") throw new Error("Windows motion animations require a numeric shared value");
        const cancel = run(next, current, (v) => write(v as T), () => {});
        cancellers.set(observable, cancel);
      } else write(next);
    },
    addListener: (id, listener) => { listeners.set(id, listener); },
    removeListener: (id) => { listeners.delete(id); },
    modify: (modifier) => { if (modifier) observable.set(modifier(current)); },
    version: () => changedAt,
    subscribe(listener) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
  };
  return observable;
}

export const Extrapolation = { IDENTITY: "identity", CLAMP: "clamp", EXTEND: "extend" } as const;
export type Extrapolation = typeof Extrapolation[keyof typeof Extrapolation];
export const ReduceMotion = { System: "system", Always: "always", Never: "never" } as const;
export function interpolate(value: number, input: readonly number[], output: readonly number[], mode: Extrapolation | string = Extrapolation.EXTEND): number {
  if (input.length !== output.length || input.length < 2) throw new Error("interpolate requires equal ranges of at least two values");
  if (mode === "identity" && (value < input[0]! || value > input.at(-1)!)) return value;
  if (mode === "clamp") value = Math.max(input[0]!, Math.min(input.at(-1)!, value));
  let i = 0;
  while (i < input.length - 2 && value > input[i + 1]!) i++;
  const width = input[i + 1]! - input[i]!;
  const t = width === 0 ? 0 : (value - input[i]!) / width;
  return output[i]! + t * (output[i + 1]! - output[i]!);
}
