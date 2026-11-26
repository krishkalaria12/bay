// What Bay answers, read without trusting its shape: the AppleScript tabs and spaces (bay.ts) and the bay command's
// history (`bay exec --json`). No Raycast imports, so `npm test` runs it with Node alone.
import * as v from "valibot";

const text = v.fallback(v.string(), "");
const count = v.fallback(v.pipe(v.number(), v.finite()), 0);
const flag = v.fallback(v.boolean(), false);

const TabSchema = v.object({
  windowId: v.pipe(v.string(), v.nonEmpty()),
  id: v.pipe(v.string(), v.nonEmpty()),
  title: text,
  url: text,
  pinned: flag,
  focused: flag,
  space: text,
});

const SpaceSchema = v.object({ id: v.pipe(v.string(), v.nonEmpty()), name: text, index: count, shown: flag });

// history()'s rows: last_visit in seconds or milliseconds since 1970, or an ISO date.
const VisitSchema = v.object({
  url: v.pipe(v.string(), v.nonEmpty()),
  title: text,
  visits: count,
  last_visit: v.fallback(v.union([v.pipe(v.number(), v.finite()), v.string()]), 0),
  space: text,
});

export type BayTab = v.InferOutput<typeof TabSchema>;

export type BaySpace = v.InferOutput<typeof SpaceSchema>;

export type Visit = { url: string; title: string; visits: number; lastVisit: number; space: string };

/** The items of a JSON array that fit the schema; anything else (bad JSON, another shape) is nothing. */
function rows<T extends v.GenericSchema>(json: string, schema: T): v.InferOutput<T>[] {
  let value: v.InferOutput<typeof JsonList>;

  try {
    value = v.parse(JsonList, JSON.parse(json));
  } catch {
    return [];
  }

  return value.flatMap((item) => {
    const parsed = v.safeParse(schema, item);

    return parsed.success ? [parsed.output] : [];
  });
}

const JsonList = v.array(v.unknown());

export const parseTabs = (json: string): BayTab[] => rows(json, TabSchema);

export const parseSpaces = (json: string): BaySpace[] =>
  rows(json, SpaceSchema)
    .map((s) => ({ ...s, name: s.name || "Space" }))
    .sort((a, b) => a.index - b.index);

const millis = (last: number | string) => (v.is(v.string(), last) ? Date.parse(last) || 0 : last < 1e12 ? last * 1000 : last);

export const parseHistory = (json: string): Visit[] =>
  rows(json, VisitSchema).map((row) => ({
    url: row.url,
    title: row.title || row.url,
    visits: row.visits,
    lastVisit: millis(row.last_visit),
    space: row.space,
  }));

/** A typed address as one Bay can open: as is with a scheme, https:// for a host, http:// for localhost or a port;
 *  null for anything else, since a search would skip the engine the person picked in Bay. */
export function addressFor(typed: string): string | null {
  const text = typed.trim();

  if (!text || /\s/.test(text)) return null;

  if (/^localhost(:\d+)?(\/.*)?$/i.test(text) || /^[^/:]+:\d+(\/.*)?$/.test(text)) return `http://${text}`;

  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;

  return /^[^/]+\.[a-z]{2,}(\/.*)?$/i.test(text) ? `https://${text}` : null;
}

/** The host Raycast shows beside a tab or visit. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
