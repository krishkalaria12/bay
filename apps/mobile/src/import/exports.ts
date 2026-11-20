/**
 * What other browsers' export files hold, read on the device. A phone's browsers keep their data to themselves, so
 * importing goes through the files they (or Google Takeout) export: a bookmarks HTML file (the Netscape format every
 * browser writes), Safari's export (a folder of Bookmarks.html and History.json) and Chrome's Takeout (Bookmarks.html
 * and History.json). Pure, so it runs in Node's tests; the native module only unpacks the archives.
 *
 * Passwords, cards and anything else secret are never read here: the native side leaves those files in the archive
 * and only names them, so the sheet can say where they stayed.
 */
import * as v from "valibot";

/** Where a folder came from in its browser, when the export marks it. */
export type BookmarkRole = "favorites" | "toolbar" | "readingList" | "other";

/** A bookmark or a folder of them, as the export had it. */
export interface ImportedBookmark {
  title: string;
  /** Absent on a folder. */
  url?: string;
  /** Milliseconds since the epoch. */
  addedAt?: number;
  children?: ImportedBookmark[];
  role?: BookmarkRole;
}

/** One page of imported history: every visit to an address, counted. */
export interface ImportedVisit {
  url: string;
  title: string;
  visits: number;
  lastVisit: number;
}

/** A file the native side found: its name in the archive and its text. */
export interface ExportFile {
  name: string;
  text: string;
}

/** What an export held, ready to review. */
export interface ExportContents {
  /** The bookmarks, as one folder whose children are the export's own top level. */
  bookmarks: ImportedBookmark;
  /** The sites the browser shows first (Safari's Favorites, Chrome's bookmarks bar), for Bay's start page. */
  favorites: ImportedBookmark[];
  /** Newest first, one entry per address. */
  history: ImportedVisit[];
}

/** How many sites the start page takes from an import. */
export const FAVORITES_LIMIT = 12;

/** The address, canonical, or null when it isn't an HTTP(S) page with a host and no credentials. */
export function webAddress(value: string): string | null {
  try {
    const url = new URL(value.trim());

    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;

    return url.href;
  } catch {
    return null;
  }
}

/** Every link under a node, in order. */
export function bookmarkLinks(node: ImportedBookmark): ImportedBookmark[] {
  if (node.url) return [node];

  return (node.children ?? []).flatMap(bookmarkLinks);
}

/** How many links a node holds. */
export const linkCount = (node: ImportedBookmark): number => (node.url ? 1 : (node.children ?? []).reduce((sum, child) => sum + linkCount(child), 0));

const ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", "\u00a0"],
]);

/** Undoes the HTML escaping exports use in titles and addresses. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;

  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);

      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }

    return ENTITIES.get(name.toLowerCase()) ?? match;
  });
}

/** A tag's attributes, lowercased by name. */
function attributes(source: string): Map<string, string> {
  const found = new Map<string, string>();

  for (const match of source.matchAll(/([a-z_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    found.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }

  return found;
}

/** An ADD_DATE (seconds since the epoch) in milliseconds. */
function addedAt(value: string | undefined): number | undefined {
  const seconds = Number(value);

  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
}

function folderRole(attrs: Map<string, string>): BookmarkRole | undefined {
  if (attrs.get("id") === "com.apple.FavoritesBar") return "favorites";

  if (attrs.get("id") === "com.apple.ReadingList") return "readingList";

  if (attrs.get("personal_toolbar_folder")?.toLowerCase() === "true") return "toolbar";

  if (attrs.get("unfiled_bookmarks_folder")?.toLowerCase() === "true") return "other";

  return undefined;
}

/** Text between the end of one tag and the next tag, without markup. */
const plainText = (html: string) =>
  decodeEntities(html.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();

/** Whether text is a bookmarks file: the Netscape format's doctype, which every browser writes. */
export const isBookmarksHTML = (text: string): boolean => /<!DOCTYPE\s+NETSCAPE-Bookmark-file/i.test(text.slice(0, 2048));

/**
 * Reads a Netscape bookmarks file. A folder is an <H3> followed by a <DL> of its entries, a bookmark an <A HREF>;
 * anything that isn't a web page (javascript:, place:, file:) is left out, and so is a folder left empty by that.
 */
export function parseBookmarksHTML(html: string): ImportedBookmark {
  const root: ImportedBookmark = { title: "", children: [] };
  const stack: ImportedBookmark[] = [root];
  // A folder's heading comes before its list: it waits here until the list opens.
  let pending: ImportedBookmark | null = null;
  // For each list still open, whether it opened a folder (and so closes one).
  const lists: boolean[] = [];

  const top = () => stack[stack.length - 1]!;
  const place = (node: ImportedBookmark) => top().children!.push(node);
  const tags = /<(\/?)(dl|h3|a)\b([^>]*)>/gi;
  // Where a heading's or link's text ends: its closing tag, in either case.
  const closers = { h3: /<\/h3\s*>/gi, a: /<\/a\s*>/gi };
  let match: RegExpExecArray | null;

  while ((match = tags.exec(html))) {
    const closing = match[1] === "/";
    const tag = match[2]!.toLowerCase();

    if (tag === "dl") {
      if (closing) {
        if (pending) place(pending);
        pending = null;

        if (lists.pop() && stack.length > 1) stack.pop();
      } else if (pending) {
        // The heading's list: the folder goes in where it was named, and its entries go in it.
        place(pending);
        stack.push(pending);
        pending = null;
        lists.push(true);
      } else {
        // The file's own list, or one with no heading: its entries stay in the folder around it.
        lists.push(false);
      }

      continue;
    }

    if (closing) continue;
    const attrs = attributes(match[3] ?? "");
    const closer = closers[tag === "h3" ? "h3" : "a"];
    closer.lastIndex = tags.lastIndex;
    const end = closer.exec(html)?.index ?? -1;
    // A tag left open ends its text at the next tag.
    const next = html.indexOf("<", tags.lastIndex);
    const title = plainText(html.slice(tags.lastIndex, end >= 0 ? end : next >= 0 ? next : undefined));

    if (end >= 0) tags.lastIndex = end;

    // A heading that never opened a list is an empty folder; the prune below drops it.
    if (pending) place(pending);
    pending = null;

    const date = addedAt(attrs.get("add_date"));

    if (tag === "h3") {
      const folder: ImportedBookmark = { title, children: [] };
      const role = folderRole(attrs);

      if (date) folder.addedAt = date;

      if (role) folder.role = role;
      pending = folder;
      continue;
    }

    const url = webAddress(decodeEntities(attrs.get("href") ?? ""));

    if (!url) continue;
    const link: ImportedBookmark = { title: title || url, url };

    if (date) link.addedAt = date;
    place(link);
  }

  if (pending) place(pending);

  return prune(root);
}

/** Drops the folders that hold no bookmarks, however deep. */
function prune(node: ImportedBookmark): ImportedBookmark {
  if (node.url) return node;
  const children = (node.children ?? []).map(prune).filter((child) => child.url || child.children?.length);

  return { ...node, children };
}

/** A time in microseconds since the epoch, as a number or the string Takeout sometimes writes. */
const micros = v.union([v.number(), v.pipe(v.string(), v.transform(Number))]);

/** A row of Safari's History.json: one page, with how often it was visited. */
const safariRow = v.object({
  url: v.string(),
  title: v.optional(v.string(), ""),
  time_usec: v.optional(micros, 0),
  visit_count: v.optional(v.number(), 1),
  // Set on a redirect Safari followed: the page it led to has its own row.
  destination_url: v.optional(v.string()),
});

/** A row of Takeout's History.json: one visit. */
const takeoutRow = v.object({
  url: v.string(),
  title: v.optional(v.string(), ""),
  time_usec: v.optional(micros, 0),
});

// A row Bay can't read is kept as null and skipped, so one odd row doesn't lose the file.
const historyFile = v.union([
  v.object({ history: v.array(v.fallback(v.nullable(safariRow), null)) }),
  v.object({ "Browser History": v.array(v.fallback(v.nullable(takeoutRow), null)) }),
]);

/** Microseconds in milliseconds; 0 when the value isn't a time. */
const fromMicros = (value: number) => (Number.isFinite(value) && value > 0 ? Math.floor(value / 1000) : 0);

/** Adds visits to the pages already counted, keeping the newest title. */
function countVisits(pages: Map<string, ImportedVisit>, visit: ImportedVisit): void {
  const previous = pages.get(visit.url);

  if (!previous) {
    pages.set(visit.url, visit);

    return;
  }

  const newer = visit.lastVisit > previous.lastVisit;

  pages.set(visit.url, {
    url: visit.url,
    title: newer ? visit.title || previous.title : previous.title || visit.title,
    visits: previous.visits + visit.visits,
    lastVisit: Math.max(previous.lastVisit, visit.lastVisit),
  });
}

/**
 * Reads a history export: Safari's History.json (`history`, one row per page with its visit count) or Takeout's
 * History.json (`Browser History`, one row per visit). Null when the text is neither. Redirects Safari followed
 * (rows with a `destination_url`) are left out, as Safari's own history list does.
 */
export function parseHistoryJSON(text: string): ImportedVisit[] | null {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }

  const file = v.safeParse(historyFile, json);

  if (!file.success) return null;
  const pages = new Map<string, ImportedVisit>();

  // Safari writes a row per page with its count; Takeout a row per visit.
  const rows =
    "history" in file.output
      ? file.output.history.map((row) =>
          row && row.destination_url === undefined ? { ...row, visits: row.visit_count > 0 ? Math.floor(row.visit_count) : 1 } : null,
        )
      : file.output["Browser History"].map((row) => row && { ...row, visits: 1 });

  for (const row of rows) {
    const url = row && webAddress(row.url);
    const lastVisit = row ? fromMicros(row.time_usec) : 0;

    if (row && url && lastVisit) countVisits(pages, { url, title: row.title.trim(), visits: row.visits, lastVisit });
  }

  return [...pages.values()].sort((a, b) => b.lastVisit - a.lastVisit);
}

/** The sites a browser shows first: the links at the top of its favorites (or bookmarks bar) folder. */
function favoritesOf(bookmarks: ImportedBookmark): ImportedBookmark[] {
  const folders = bookmarks.children ?? [];
  const folder = folders.find((child) => child.role === "favorites") ?? folders.find((child) => child.role === "toolbar");
  const seen = new Set<string>();

  return (folder?.children ?? []).filter((child) => child.url && !seen.has(child.url) && seen.add(child.url)).slice(0, FAVORITES_LIMIT);
}

/** A file that isn't one of the formats above. */
export class UnknownExportError extends Error {
  constructor() {
    super("This file doesn't hold bookmarks or history Bay can read.");
    this.name = "UnknownExportError";
  }
}

/**
 * Reads every file an export held. Bookmark files merge into one tree, history files into one list; files in no
 * format Bay knows are skipped. Throws UnknownExportError when not one file could be read.
 */
export function readExport(files: readonly ExportFile[]): ExportContents {
  const bookmarks: ImportedBookmark = { title: "", children: [] };
  const history = new Map<string, ImportedVisit>();
  let recognised = false;

  for (const file of files) {
    if (isBookmarksHTML(file.text)) {
      recognised = true;
      bookmarks.children!.push(...(parseBookmarksHTML(file.text).children ?? []));
      continue;
    }

    const visits = /^\s*\{/.test(file.text) ? parseHistoryJSON(file.text) : null;

    if (!visits) continue;
    recognised = true;

    for (const visit of visits) countVisits(history, visit);
  }

  if (!recognised) throw new UnknownExportError();

  return {
    bookmarks,
    favorites: favoritesOf(bookmarks),
    history: [...history.values()].sort((a, b) => b.lastVisit - a.lastVisit),
  };
}
