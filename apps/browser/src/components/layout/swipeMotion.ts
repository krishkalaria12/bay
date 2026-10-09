import { CAPSULE_INSET, RUBBER_COEFFICIENT, SWIPE_LIST_ROW, SWIPE_UNIT } from "./constants";

export function rubberBand(value: number, limit: number, dimension: number, c = RUBBER_COEFFICIENT) {
  if (value <= limit) return value;
  return limit + (1 - 1 / (((value - limit) * c) / dimension + 1)) * dimension;
}

export const swipeProgress = (distance: number) => Math.max(0, distance / SWIPE_UNIT);

export function capsuleOffset(progress: number, width: number) {
  const limit = width + CAPSULE_INSET;
  return rubberBand(progress * limit, limit, limit) - width;
}

export function springParams(response: number, dampingRatio: number) {
  return { stiffness: (2 * Math.PI / response) ** 2, damping: (4 * Math.PI * dampingRatio) / response, mass: 1 };
}

export function listSelection(dySinceShown: number, count: number) {
  const rows = dySinceShown / SWIPE_UNIT;
  const index = Math.max(0, Math.min(count - 1, Math.round(rows)));
  const past = rows < 0 ? rows : rows > count - 1 ? rows - (count - 1) : 0;
  const overshoot = Math.abs(past) * SWIPE_UNIT;
  const nudge = past ? Math.sign(past) * SWIPE_LIST_ROW * (1 - 1 / (0.1 * overshoot + 1)) * 0.5 : 0;
  return { index, nudge };
}
