// One requestAnimationFrame loop for every animated effect in the document. It runs only while something is
// subscribed, and a frame after a long gap (a hidden tab, a stalled window) advances effect time by one frame
// instead of catching up.

type Tick = (dt: number) => void;

const ticks = new Set<Tick>();
let frame = 0;
let last: number | null = null;
const FRAME = 1 / 60;

function run(now: number) {
  frame = 0;
  const dt = last === null ? FRAME : (now - last) / 1000;
  last = now;
  for (const tick of ticks) tick(dt > 0.25 || dt < 0 ? FRAME : dt);
  if (ticks.size && !frame) frame = requestAnimationFrame(run);
  else last = null;
}

/** Calls `tick` with seconds since the previous frame until the returned function is called. */
export function subscribe(tick: Tick): () => void {
  ticks.add(tick);
  if (!frame) frame = requestAnimationFrame(run);
  return () => {
    ticks.delete(tick);
    if (!ticks.size && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
      last = null;
    }
  };
}

/** How many effects are subscribed, for the idle checks. */
export const subscribers = () => ticks.size;
