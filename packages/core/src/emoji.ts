import { EMOJI_GROUPS } from "./emojiData.ts";

export type EmojiMatch = { value: string; name: string };

const normalize = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const entries = EMOJI_GROUPS.flatMap((group) =>
  group.emoji.map((entry) => {
    const separator = entry.indexOf(" ");
    const name = entry.slice(separator + 1);
    const normalized = normalize(name);
    return { value: entry.slice(0, separator), name, normalized, words: normalized.split(" ") };
  }),
);

/** Explicit emoji searches keep ordinary queries such as "heart" available for web search. */
export function findEmoji(raw: string, limit = 5): EmojiMatch[] {
  const match = raw.trim().match(/^emoji\s+(.+)$/i);
  if (!match || !Number.isFinite(limit) || limit < 1) return [];
  const query = normalize(match[1]!);
  if (!query) return [];
  const tokens = query.split(" ");

  return entries
    .filter((entry) => tokens.every((token) => entry.words.some((word) => word.startsWith(token))))
    .map((entry) => ({
      entry,
      rank:
        entry.normalized === query
          ? 0
          : query === "heart" && entry.normalized === "red heart"
            ? 1
            : entry.normalized.startsWith(query)
              ? 2
              : tokens.every((token) => entry.words.includes(token))
                ? 3
                : 4,
    }))
    .sort((a, b) => a.rank - b.rank || a.entry.name.length - b.entry.name.length || a.entry.name.localeCompare(b.entry.name))
    .slice(0, Math.floor(limit))
    .map(({ entry }) => ({ value: entry.value, name: entry.name }));
}
