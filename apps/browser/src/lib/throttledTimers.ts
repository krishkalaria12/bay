// The app's periodic work at idle, on one timer. Every React Native timer firing wakes the JS thread (and often the
// main thread), and each setInterval kept its own phase, so an idle app woke for one or another more than once a
// second. Here every job runs on a shared wall-clock grid: periods are multiples of each other (10 s, 30 s, 60 s,
// 5 min, 30 min), so jobs due together run in one wake. A job can say whether it has anything to do (`needed`) and
// which store change can make it so (`watch`); with nothing needed there is no timer at all.

type Unsubscribe = () => void;

export type SlowJob = {
  // Its period in ms. It runs at the multiples of it on the wall clock.
  every: number;
  run: () => void;
  // Whether it has anything to do now (default: always). Read again when `watch` reports a change.
  needed?: () => boolean;
  // Subscribes to what can change `needed`; calls `changed` then.
  watch?: (changed: () => void) => Unsubscribe;
};

type Entry = SlowJob & { next: number; armed: boolean };

// A wake this close before a job's slot runs it now rather than waking again for it.
const GRID_SLACK_MS = 50;

const jobs = new Set<Entry>();
let timer: ReturnType<typeof setTimeout> | null = null;
let timerAt = Infinity;
let clock = () => Date.now();
let firing = false;

const slotAfter = (t: number, every: number) => (Math.floor(t / every) + 1) * every;

const isNeeded = (job: Entry) => {
  try {
    return job.needed ? job.needed() : true;
  } catch {
    return true;
  }
};

/** Runs `job` every `job.every` ms on the shared grid, while it's needed. Returns its cancel. */
export function everySlowly(job: SlowJob): Unsubscribe {
  const entry: Entry = { ...job, next: slotAfter(clock(), job.every), armed: false };
  jobs.add(entry);
  let unwatch: Unsubscribe | undefined;
  try {
    unwatch = job.watch?.(reschedule);
    reschedule();
  } catch (error) {
    jobs.delete(entry);
    unwatch?.();
    if (!timer) timerAt = Infinity;
    throw error;
  }
  return () => {
    jobs.delete(entry);
    try {
      unwatch?.();
    } finally {
      reschedule();
    }
  };
}

/** Reads every job's `needed` again and moves the timer to the earliest slot due. */
export function reschedule() {
  // A batch reschedules once, after its callbacks.
  if (firing) return;
  const now = clock();
  let next = Infinity;
  for (const job of jobs) {
    if (!isNeeded(job)) {
      job.armed = false;
      continue;
    }
    // A job that just became needed waits for its next slot; one already armed keeps its deadline.
    if (!job.armed && job.next <= now) job.next = slotAfter(now, job.every);
    job.armed = true;
    next = Math.min(next, job.next);
  }
  if (next === timerAt) return;
  if (timer) clearTimeout(timer);
  timer = null;
  timerAt = next;
  if (next !== Infinity) timer = setTimeout(fire, Math.max(0, next - now));
}

function fire() {
  timer = null;
  timerAt = Infinity;
  const now = clock();
  // Every due job advances before any runs, so a callback that reschedules sees the batch's next slots.
  const due = [...jobs].filter((job) => job.armed && job.next <= now + GRID_SLACK_MS);
  for (const job of due) job.next = slotAfter(Math.max(now, job.next), job.every);
  firing = true;
  try {
    for (const job of due) {
      if (!jobs.has(job) || !isNeeded(job)) continue;
      try {
        job.run();
      } catch (error) {
        console.error(error);
      }
    }
  } finally {
    firing = false;
  }
  reschedule();
}

/** Tests: a fake clock, and the timer's next deadline. */
export function slowTimersForTests(now: () => number) {
  for (const job of jobs) job.next = slotAfter(now(), job.every);
  clock = now;
  return {
    pending: () => (timer ? timerAt : null),
    fire: () => {
      if (timer) clearTimeout(timer);
      fire();
    },
    clear: () => {
      jobs.clear();
      if (timer) clearTimeout(timer);
      timer = null;
      timerAt = Infinity;
    },
  };
}
