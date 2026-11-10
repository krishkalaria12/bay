/**
 * The saved-logins format (B20), pure so it can be tested without the secure store's native module: one JSON
 * document, a list of entries keyed per origin + username, most recent save last. Messages from storage are
 * untrusted, so everything is validated and repaired (a refresh of the tab list can only replace, never corrupt).
 */

import * as v from "valibot";

export interface SavedLogin {
  /** Scheme + host (+ port) of the server that asked: the key a later challenge looks up by. */
  origin: string;
  username: string;
  password: string;
  /** When it was saved (milliseconds since epoch). */
  savedAt: number;
}

const loginSchema = v.object({
  origin: v.string(),
  username: v.string(),
  password: v.string(),
  savedAt: v.number(),
});

/** Parses the stored document; null for anything unparseable or malformed (entries dedupe by origin + username, newest wins). */
export function parseSavedLogins(value: string | null): SavedLogin[] {
  if (!value) return [];

  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }

  const logins = v.array(
    v.pipe(
      loginSchema,
      v.transform((login) => ({
        origin: login.origin.trim(),
        username: login.username,
        password: login.password,
        savedAt: login.savedAt,
      })),
    ),
  );

  const result = v.safeParse(logins, parsed);

  if (!result.success) return [];

  const byKey = new Map<string, SavedLogin>();

  for (const login of result.output) {
    if (login.origin && login.username) byKey.set(`${login.origin}\n${login.username}`, login);
  }

  return [...byKey.values()];
}

/** Serialises the logins for the secure store. */
export function formatSavedLogins(logins: readonly SavedLogin[]): string {
  return JSON.stringify(logins);
}

/** The origin a page request belongs to, for later matching: scheme + host + port, or null when it isn't a web page. */
export function originOf(value: string): string | null {
  try {
    const url = new URL(value);

    return ["http:", "https:"].includes(url.protocol) && url.hostname ? url.origin : null;
  } catch {
    return null;
  }
}
