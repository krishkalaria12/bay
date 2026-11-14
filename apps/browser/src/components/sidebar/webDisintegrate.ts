import { documentSpecks } from "@bay/desktop";
import type { Anchor } from "./state";

// The sidebar's Clear on the Chrome-hosted desktop, as Disintegrate.swift draws it on macOS: each row's own pixels (the
// host reads them, clear_specks.cc) drift left as a clump, then scatter and fade, sweeping from its left edge to its
// right. Drawn on a canvas over the window.

const DURATION = 0.85;
const SWEEP = 0.22;
const SPECK = 0.8;

export type Speck = { x: number; y: number; color: string; size: number; delay: number; life: number; drift: [number, number]; end: [number, number] };

const between = (random: () => number, low: number, high: number) => low + random() * (high - low);
const easeIn = (t: number) => t * t;
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);

/** A row's specks from the host's `[x, y, r, g, b, a]` runs, each with its own path and timing. */
export function specksFor(row: Anchor, runs: number[], random: () => number = Math.random): Speck[] {
  const specks: Speck[] = [];

  for (let i = 0; i + 5 < runs.length; i += 6) {
    // SAFETY: the checks above established this shape.
    const [x, y, r, g, b, a] = runs.slice(i, i + 6) as [number, number, number, number, number, number];
    const drift: [number, number] = [x - between(random, 14, 34), y + between(random, -4, 6)];
    specks.push({
      x,
      y,
      color: `rgba(${r}, ${g}, ${b}, ${a / 255})`,
      size: SPECK * between(random, 0.75, 1.4),
      delay: SWEEP * ((x - row.x) / Math.max(row.width, 1)) + between(random, 0, 0.06),
      life: DURATION * between(random, 0.75, 1.1),
      drift,
      end: [drift[0] + between(random, -46, 30), drift[1] + between(random, -42, 42)],
    });
  }

  return specks;
}

const along = (from: [number, number], to: [number, number], k: number) => ({ x: from[0] + (to[0] - from[0]) * k, y: from[1] + (to[1] - from[1]) * k });

// Solid, then to three quarters, then gone: Core Animation's keyframes [1, 1, 0.75, 0] at [0, 0.35, 0.7, 1].
function opacityAt(t: number): number {
  if (t < 0.35) return 1;

  if (t < 0.7) return 1 - 0.25 * ((t - 0.35) / 0.35);

  return 0.75 * (1 - (t - 0.7) / 0.3);
}

/** Where a speck is `seconds` in, and how opaque; it waits where it started until its turn. Null once it's gone. */
export function speckAt(speck: Speck, seconds: number): { x: number; y: number; opacity: number } | null {
  const t = (seconds - speck.delay) / speck.life;

  if (t >= 1) return null;

  if (t <= 0) return { x: speck.x, y: speck.y, opacity: 1 };
  const opacity = opacityAt(t);

  if (t < 0.4) return { ...along([speck.x, speck.y], speck.drift, easeIn(t / 0.4)), opacity };

  return { ...along(speck.drift, speck.end, easeOut((t - 0.4) / 0.6)), opacity };
}

/** Starts the rows breaking up, once their pixels are read; resolves then, so the rows can go while it plays. */
export async function webDisintegrate(rows: Anchor[]): Promise<void> {
  const runs = await documentSpecks(rows);
  const specks = rows.flatMap((row, i) => specksFor(row, runs[i] ?? []));

  if (!specks.length) return;
  const canvas = document.createElement("canvas");
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * scale);
  canvas.height = Math.round(window.innerHeight * scale);
  Object.assign(canvas.style, { position: "fixed", inset: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: "10000" });
  document.body.append(canvas);
  const context = canvas.getContext("2d");

  if (!context) return canvas.remove();
  context.scale(scale, scale);
  const start = performance.now();

  const frame = (now: number) => {
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    let drawn = false;

    for (const speck of specks) {
      const at = speckAt(speck, (now - start) / 1000);

      if (!at) continue;
      drawn = true;
      context.globalAlpha = at.opacity;
      context.fillStyle = speck.color;
      context.fillRect(at.x - speck.size / 2, at.y - speck.size / 2, speck.size, speck.size);
    }

    if (drawn) requestAnimationFrame(frame);
    else canvas.remove();
  };

  requestAnimationFrame(frame);
}
