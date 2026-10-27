// Static effects (the window backdrop) share one WebGL2 context per document. Each view keeps a plain 2D canvas;
// the producer draws a view's frame and copies it there at once, so any number of backdrops costs one context, and
// a view redraws only when its inputs, CSS size or device pixel ratio change. Requests coalesce to one draw per
// view per frame, keeping only the latest.

import { createSurface, glLimit, targetSize, type Source, type Surface, type UniformValues } from "./surface";

export type StaticJob = {
  source: Source;
  cssWidth: number;
  cssHeight: number;
  values: (cssWidth: number, cssHeight: number) => UniformValues;
};

type Target = { canvas: HTMLCanvasElement; job: StaticJob | null; onResult: (ok: boolean) => void };

const targets = new Set<Target>();
const pending = new Set<Target>();
let surface: Surface | null | undefined;
let producer: HTMLCanvasElement | null = null;
let frame = 0;
export const staticStats = { draws: 0, contexts: 0 };

function producerSurface(): Surface | null {
  if (surface !== undefined) return surface;
  producer = document.createElement("canvas");
  producer.width = producer.height = 1;
  surface = createSurface(
    producer,
    () => {
      for (const t of targets) t.onResult(false);
    },
    () => {
      for (const t of targets) pending.add(t);
      schedule();
    },
  );
  if (surface) staticStats.contexts++;
  return surface;
}

function schedule() {
  if (!frame && pending.size) frame = requestAnimationFrame(flush);
}

function flush() {
  frame = 0;
  const s = producerSurface();
  const jobs = [...pending];
  pending.clear();
  for (const target of jobs) {
    if (!targets.has(target) || !target.job) continue;
    target.onResult(!!s && !s.lost && draw(s, target, target.job));
  }
}

function draw(s: Surface, target: Target, job: StaticJob): boolean {
  const { gl } = s;
  const size = targetSize(job.cssWidth, job.cssHeight, globalThis.devicePixelRatio ?? 1, glLimit(gl));
  if (!size || !producer) return false;
  // The producer only grows, so views of different sizes don't reallocate it on every draw.
  if (producer.width < size.width || producer.height < size.height) {
    producer.width = Math.max(producer.width, size.width);
    producer.height = Math.max(producer.height, size.height);
  }
  gl.viewport(0, 0, size.width, size.height);
  gl.disable(gl.BLEND);
  if (!s.draw(job.source, job.values(job.cssWidth, job.cssHeight))) return false;
  const { canvas } = target;
  if (canvas.width !== size.width || canvas.height !== size.height) {
    canvas.width = size.width;
    canvas.height = size.height;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.clearRect(0, 0, size.width, size.height);
  // The viewport sits at the producer's bottom-left; the 2D canvas counts rows from the top.
  ctx.drawImage(producer, 0, producer.height - size.height, size.width, size.height, 0, 0, size.width, size.height);
  staticStats.draws++;
  return true;
}

/** A view's slot in the shared producer. `onResult` reports whether its canvas now shows the latest frame. */
export function registerStatic(canvas: HTMLCanvasElement, onResult: (ok: boolean) => void) {
  const target: Target = { canvas, job: null, onResult };
  targets.add(target);
  return {
    update(job: StaticJob) {
      target.job = job;
      pending.add(target);
      schedule();
    },
    dispose() {
      targets.delete(target);
      pending.delete(target);
    },
  };
}
