// What changed between two versions of an id-keyed record of the store (`tabs`, `live`): the ids whose entry is new,
// replaced or gone. Several store listeners ask it of the same update, so it's worked out once per pair: a pass over
// 200 tabs costs Hermes ~15 µs (a `for…in` alone costs that), and listeners each made their own on every update.

const NONE: readonly string[] = [];
// Both versions must be weak keys: a strong predecessor would keep the entire update history alive through `next`.
const memo = new WeakMap<object, WeakMap<object, readonly string[]>>();

function remember(next: object, prev: object, ids: readonly string[]) {
  let pairs = memo.get(next);
  if (!pairs) memo.set(next, (pairs = new WeakMap()));
  pairs.set(prev, ids);
}

/** A single-entry update already knows its delta; listeners needn't scan the whole record to rediscover it. */
export function withChangedEntry<T>(prev: Record<string, T>, id: string, value: T): Record<string, T> {
  if (prev[id] === value) return prev;
  const next = { ...prev, [id]: value };
  remember(next, prev, [id]);
  return next;
}

export function changedIds<T>(next: Record<string, T>, prev: Record<string, T>): readonly string[] {
  if (next === prev) return NONE;
  const hit = memo.get(next)?.get(prev);
  if (hit) return hit;
  const ids: string[] = [];
  const keys = Object.keys(next);
  let added = 0;
  for (let i = 0; i < keys.length; i++) {
    const id = keys[i]!;
    const before = prev[id];
    if (next[id] === before) continue;
    ids.push(id);
    if (before === undefined) added++;
  }
  // Fewer kept ids than `prev` had: some are gone.
  const before = Object.keys(prev);
  if (before.length > keys.length - added) for (const id of before) if (next[id] === undefined) ids.push(id);
  remember(next, prev, ids);
  return ids;
}

type Audible = { playingAudio?: boolean };
let audioOf: Record<string, Audible> | null = null;
let audioVersion: object = {};

/**
 * A value that changes only when a tab starts or stops playing audio. A selector that reads no more of `live` than
 * that compares this instead of `live`, which every page's progress report replaces.
 */
export function playingAudioVersion(live: Record<string, Audible>): object {
  if (live === audioOf) return audioVersion;
  const was = audioOf;
  if (!was || changedIds(live, was).some((id) => !!live[id]?.playingAudio !== !!was[id]?.playingAudio)) audioVersion = {};
  audioOf = live;
  return audioVersion;
}
