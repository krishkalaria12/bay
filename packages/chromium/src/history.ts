import * as v from "valibot";
import { engineCall, onEngineEvent } from "./engineInfo";

// Chrome's history (HistoryService), the one store of it. Chrome records visits itself; the app reads it as one
// row per URL and keeps no copy on disk. Profiles are engine profiles ("" is the default); private ones have none.

/** One URL: Chrome's visit count and its user-visible visit times (ms, oldest first, the newest 50). */
export type EngineHistoryEntry = { url: string; title: string; visits: number; visitTimes: number[] };

export type HistoryChange =
  | { kind: "visit"; profile: string; url: string; title: string; visits: number; at: number }
  | { kind: "modified"; profile: string; rows: { url: string; title: string; visits: number }[] }
  /** `all`: a time range went (Clear Browsing Data, expiry), so re-read; else whole URLs did. */
  | { kind: "deleted"; profile: string; all: boolean; urls: string[] };

type Row = { u: string; t: string; n: number };

export async function queryHistory(profile: string, maxUrls = 5000, maxVisits = 50): Promise<EngineHistoryEntry[]> {
  const { entries } = await engineCall<{ entries: (Row & { v: number[] })[] }>("nn_history_query", profile, { maxUrls, maxVisits });

  return entries.map((e) => ({ url: e.u, title: e.t, visits: e.n, visitTimes: e.v }));
}

// One add at a time per profile: Chrome checks what a URL has, then adds what's missing, so two adds of the same
// visit at once would both add it.
const adding = new Map<string, Promise<unknown>>();

/**
 * Adds each visit the URL doesn't already have (each visit Chrome has accounts for one within `toleranceMs`);
 * resolves with how many it added.
 */
export function addHistoryVisits(profile: string, pages: { url: string; title: string; visitTimes: number[] }[], toleranceMs = 1000) {
  if (!pages.length) return Promise.resolve(0);

  const run = (adding.get(profile) ?? Promise.resolve())
    .catch(() => {})
    .then(() => engineCall<{ added: number }>("nn_history_add", profile, { pages: pages.map((p) => ({ u: p.url, t: p.title, v: p.visitTimes })), toleranceMs }))
    .then((r) => r.added);

  adding.set(profile, run);

  return run;
}

/** Chrome's importer path: a new URL gets `visits` as its count and one visit at `lastVisit`. */
export const importHistoryRows = (profile: string, rows: { url: string; title: string; visits: number; lastVisit: number }[]) =>
  rows.length
    ? engineCall("nn_history_import", profile, { rows: rows.map((r) => ({ u: r.url, t: r.title, n: r.visits, l: r.lastVisit })) })
    : Promise.resolve();

export const deleteHistoryUrls = (profile: string, urls: string[]) =>
  urls.length ? engineCall("nn_history_delete_urls", profile, { urls }) : Promise.resolve();

/** Starts `onHistoryChanged` events for the profile. */
export const watchHistory = (profile: string) => engineCall("nn_history_watch", profile);

const RowSchema = v.object({ u: v.string(), t: v.string(), n: v.number() });

const HistoryChangeSchema = v.variant("kind", [
  v.object({ kind: v.literal("visit"), u: v.string(), t: v.string(), n: v.number(), at: v.number() }),
  v.object({ kind: v.literal("modified"), rows: v.array(RowSchema) }),
  v.object({ kind: v.literal("deleted"), all: v.optional(v.boolean(), false), urls: v.optional(v.array(v.string()), []) }),
]);

type RawChange = v.InferOutput<typeof HistoryChangeSchema>;

// The engine sends each change with the profile whose store it touched, alone or batched (see below).
const HistoryEventSchema = v.variant("kind", [
  v.object({ kind: v.literal("batch"), profile: v.string(), changes: v.optional(v.array(HistoryChangeSchema), []) }),
  v.object({ kind: v.literal("visit"), profile: v.string(), u: v.string(), t: v.string(), n: v.number(), at: v.number() }),
  v.object({ kind: v.literal("modified"), profile: v.string(), rows: v.array(RowSchema) }),
  v.object({ kind: v.literal("deleted"), profile: v.string(), all: v.optional(v.boolean(), false), urls: v.optional(v.array(v.string()), []) }),
]);

function toChange(change: RawChange, profile: string): HistoryChange {
  if (change.kind === "visit") return { kind: "visit", profile, url: change.u, title: change.t, visits: change.n, at: change.at };

  if (change.kind === "modified") return { kind: "modified", profile, rows: change.rows.map((r) => ({ url: r.u, title: r.t, visits: r.n })) };

  return { kind: "deleted", profile, all: change.all, urls: change.urls };
}

// The engine sends the changes of each ~20 ms together ({kind: "batch", changes}), in order: an add of many visits
// (history.json's move, sync) made one event per visit, ~88,000 at one launch.
export const onHistoryChanged = (listener: (change: HistoryChange) => void) =>
  onEngineEvent((_topic, payload) => {
    const parsed = v.safeParse(HistoryEventSchema, payload);

    if (!parsed.success) return;
    const event = parsed.output;

    if (event.kind === "batch") for (const change of event.changes) listener(toChange(change, event.profile));
    else listener(toChange(event, event.profile));
  }, "history.changed");
