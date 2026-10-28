import { hasWebKit } from "@bay/nncore";
import { SETTINGS, type SettingEntry } from "./definitions";

export type { SettingEntry } from "./definitions";

// Settings › Engines is macOS's (WebKit), so a build without it doesn't list its settings.
const SEARCH_SETTINGS: SettingEntry[] = Object.values(SETTINGS).filter((e) => e.pane !== "engines" || hasWebKit());

// Typing a lot of the alphabet shouldn't list half the settings: a handful, best first.
const MAX_RESULTS = 6;

const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}⌘⌥⇧]+/u)
    .filter(Boolean);

/** The settings whose words start with each of the query's: titles that start with it first, then titles that have
 *  it, then the rest. */
export function findSettings(query: string): SettingEntry[] {
  if (query.trim().length < 2) return [];
  const terms = wordsOf(query);
  if (!terms.length) return [];
  const has = (words: string[]) => terms.every((t) => words.some((w) => w.startsWith(t)));
  const scoreOf = (title: string[]) => {
    if (title[0]?.startsWith(terms[0]!)) return 0;
    if (has(title)) return 1;
    return 2;
  };
  const scored: { entry: SettingEntry; score: number }[] = [];
  for (const entry of SEARCH_SETTINGS) {
    const title = wordsOf(entry.title);
    if (has([...title, ...wordsOf(entry.words ?? "")])) scored.push({ entry, score: scoreOf(title) });
  }
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_RESULTS)
    .map((s) => s.entry);
}
