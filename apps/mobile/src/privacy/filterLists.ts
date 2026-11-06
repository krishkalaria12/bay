/** The filter lists both engines block with: uBlock Origin's default set (as on desktop) plus cookie notices. */
export const FILTER_LISTS = [
  { id: "ublock-filters", title: "uBlock filters", url: "https://ublockorigin.github.io/uAssets/filters/filters.min.txt" },
  { id: "ublock-privacy", title: "uBlock filters – Privacy", url: "https://ublockorigin.github.io/uAssets/filters/privacy.min.txt" },
  { id: "ublock-unbreak", title: "uBlock filters – Unbreak", url: "https://ublockorigin.github.io/uAssets/filters/unbreak.min.txt" },
  { id: "ublock-badware", title: "uBlock filters – Badware risks", url: "https://ublockorigin.github.io/uAssets/filters/badware.min.txt" },
  { id: "easylist", title: "EasyList", url: "https://easylist.to/easylist/easylist.txt" },
  { id: "easyprivacy", title: "EasyPrivacy", url: "https://easylist.to/easylist/easyprivacy.txt" },
  { id: "plowe", title: "Peter Lowe's list", url: "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblock&showintro=0&mimetype=plaintext" },
  { id: "cookies", title: "EasyList Cookie", url: "https://secure.fanboy.co.nz/fanboy-cookiemonster.txt" },
] as const;

export type FilterListId = (typeof FILTER_LISTS)[number]["id"];

/**
 * Bumped whenever the engines read the same list text differently, so the rules they cached for a list version are
 * rebuilt. 2: a bare hostname line is a hostname rule (Peter Lowe's `t.co` had blocked YouTube's avatars).
 */
export const ENGINE_RULES = 2;

/** Lists are refreshed once a day, like Lens. */
export const REFRESH_AFTER = 24 * 60 * 60 * 1000;

export function isStale(fetchedAt: number | undefined, now: number): boolean {
  return fetchedAt === undefined || now - fetchedAt >= REFRESH_AFTER || fetchedAt > now;
}

/** A list's HTTP validators, from its response headers. */
export interface ListValidators {
  etag?: string;
  lastModified?: string;
}

/** The server's list matches the saved copy: same ETag, or with no ETag on either side, the same Last-Modified. */
export function listUnchanged(saved: ListValidators, current: ListValidators): boolean {
  if (saved.etag && current.etag) return saved.etag === current.etag;

  return Boolean(saved.lastModified && saved.lastModified === current.lastModified);
}

/** A short name for list text (FNV-1a), so an engine can tell an update from text it has already compiled. */
export function listVersion(text: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return `${text.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

/** A download is plausible filter text, not an error page: judged from its first bytes and its size. */
export function looksLikeFilterList(head: string, size: number): boolean {
  const start = head.trimStart().slice(0, 200).toLowerCase();

  return size > 1000 && !start.startsWith("<!doctype") && !start.startsWith("<html");
}
