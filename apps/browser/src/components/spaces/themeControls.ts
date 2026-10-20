// The theme editor's wave and dial, as numbers: where the wave runs and where the dial points.

export type Point = { x: number; y: number };

/**
 * The wave slider's line from `from` to `to` across a band `height` tall: flat at 0, a full wave at 1 (Zen draws its
 * intensity this way), sampled every `step`.
 */
export function wavePoints(from: number, to: number, height: number, value: number, amplitude: number, period: number, step = 3): Point[] {
  const mid = height / 2;
  const a = Math.min(1, Math.max(0, value)) * amplitude;
  const points: Point[] = [];
  for (let x = from; x < to; x += step) points.push({ x, y: mid - Math.sin(((x - from) / period) * 2 * Math.PI) * a });
  points.push({ x: to, y: mid - Math.sin(((to - from) / period) * 2 * Math.PI) * a });
  return points;
}

/** A segment between two points as a rotated bar: its centre, length and angle (radians). */
export function segment(a: Point, b: Point): { x: number; y: number; length: number; angle: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, length: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x) };
}

/** The dial's value for a pointer `dx`, `dy` from its centre: clockwise from the top, snapped to `steps`; a turn is 0. */
export function dialValue(dx: number, dy: number, steps: number): number {
  const turn = (Math.atan2(dx, -dy) / (2 * Math.PI) + 1) % 1;
  const step = Math.round(turn * steps) % steps;
  return step / steps;
}

/** Where on a dial of `radius` a value points: clockwise from the top. */
export function dialPoint(value: number, radius: number): Point {
  const angle = value * 2 * Math.PI;
  return { x: Math.sin(angle) * radius, y: -Math.cos(angle) * radius };
}
