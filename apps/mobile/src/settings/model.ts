// Settings without the screen: its pages, the index's groups, rows and sections as plain values, and the search that
// finds a page or a row by what it says. After Yab's Settings (Phone/Sources/Settings/SettingsContent.swift and
// SettingsIndex.swift, Apache-2.0): one index of pages, each page a header and sections of rows with words under them.

import type { IconName } from "../chrome/Icon.types.ts";

/** The pages Settings can show. The first ones are on the index; the rest open from a row on another page. */
export const SETTINGS_PAGES = [
  "general",
  "search",
  "appearance",
  "tabs",
  "privacy",
  "passwords",
  "youtube",
  "about",
  "defaultBrowser",
  "language",
  "swipe",
  "appLinks",
  "customEngine",
  "wallpaper",
  "textSize",
  "archive",
  "startPage",
] as const;

export type SettingsPage = (typeof SETTINGS_PAGES)[number];

/** Something the index opens that isn't a page of Settings: one of the browser's own sheets, or an action. */
export type IndexAction = "bookmarks" | "history" | "downloads" | "import" | "report";

/** A row of the index. */
export type IndexEntry = { type: "page"; page: SettingsPage } | { type: "action"; action: IndexAction };

/** The index's cards, as Yab groups its own: the basic pages, what Bay keeps and guards, your things, then Bay itself. */
export const INDEX: readonly (readonly IndexEntry[])[] = [
  [page("general"), page("search"), page("appearance"), page("tabs")],
  [page("privacy"), page("passwords"), page("youtube")],
  [action("bookmarks"), action("history"), action("downloads"), action("import")],
  [page("about"), action("report")],
];

function page(id: SettingsPage): IndexEntry {
  return { type: "page", page: id };
}

function action(id: IndexAction): IndexEntry {
  return { type: "action", action: id };
}

/** An entry's id, for test ids and the search's results: the page's or the action's name. */
export function entryId(entry: IndexEntry): string {
  return entry.type === "page" ? entry.page : entry.action;
}

/** What a row does when tapped. */
export type RowKind =
  /** Opens its page (a chevron); `checked` adds a tick, for a choice that has a page of its own. */
  | { type: "page"; page: SettingsPage; checked?: boolean }
  /** One of a page's choices (a tick when chosen). */
  | { type: "choice"; selected: boolean; choose: () => void }
  | { type: "toggle"; on: boolean; set: (on: boolean) => void }
  /** Does something now: no chevron. */
  | { type: "action"; run: () => void }
  /** Says something; no tap. */
  | { type: "info" };

export interface SettingsRow {
  /** Unique on its page: the search's target, and what the page scrolls to. */
  id: string;
  testID: string;
  label: string;
  /** A second line under the label. */
  detail?: string;
  /** The current setting, at the right. */
  value?: string;
  /** In its grey square before the label; "mark" is Bay's own icon. */
  icon?: IconName | "mark";
  kind: RowKind;
  /** The label in red: an action that ends something. */
  danger?: boolean;
  disabled?: boolean;
}

export interface SettingsSection {
  id: string;
  title?: string;
  rows: readonly SettingsRow[];
  /** What the rows above mean, in small print under the group. */
  footer?: string;
  /** The footer's test id, where a test reads it. */
  footerTestID?: string;
}

/** An index entry as the search reads it: its name, the words it's known by, and its rows (none for an action). */
export interface SearchEntry {
  entry: IndexEntry;
  title: string;
  keywords: string;
  /** Its pages' rows: `page` names the page a row is on, when it is one further in. */
  rows: readonly { id: string; label: string; detail?: string; value?: string; page?: SettingsPage }[];
}

export interface SettingsMatch {
  entry: IndexEntry;
  /** The row that matched, to scroll to; none when the name or its words did. */
  row?: string;
  /** The page the row is on, when it isn't the entry's own (a choice one page further in). */
  page?: SettingsPage;
  /** What the result says under the name: the row that matched. */
  detail?: string;
  id: string;
}

/** Words of a query or a text, lowercased, in any script. */
export function words(text: string): string[] {
  return text
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter(Boolean);
}

/**
 * What a query finds: every word of it starts a word of what it searches. An entry's name first, then a row on it (so
 * "dark" opens the Dark choice, not just Appearance), then the words it is known by. An exact name comes first, then
 * whole entries before rows, then by name.
 */
export function matchSettings(query: string, entries: readonly SearchEntry[]): SettingsMatch[] {
  const tokens = words(query);

  if (!tokens.length) return [];

  const finds = (text: string) => {
    const candidates = words(text);

    return tokens.every((token) => candidates.some((candidate) => candidate.startsWith(token)));
  };

  const matches: (SettingsMatch & { title: string })[] = [];

  for (const entry of entries) {
    const id = entryId(entry.entry);

    if (finds(entry.title)) {
      matches.push({ entry: entry.entry, id, title: entry.title });

      continue;
    }

    const row = entry.rows.find((candidate) => finds([candidate.label, candidate.detail ?? "", candidate.value ?? ""].join(" ")));

    if (row) matches.push({ entry: entry.entry, row: row.id, page: row.page, detail: row.label, id: `${id}.${row.page ?? id}.${row.id}`, title: entry.title });
    else if (finds(entry.keywords)) matches.push({ entry: entry.entry, id, title: entry.title });
  }

  const typed = query.trim().toLocaleLowerCase();
  const exact = (match: { title: string }) => match.title.toLocaleLowerCase() === typed;

  return matches
    .sort((a, b) => Number(exact(b)) - Number(exact(a)) || Number(a.row !== undefined) - Number(b.row !== undefined) || a.title.localeCompare(b.title))
    .map(({ title: _title, ...match }) => match);
}

/** Where ‹ goes from a page: the page that opened it, or the index. */
export const PARENT: Record<SettingsPage, SettingsPage | null> = {
  general: null,
  search: null,
  appearance: null,
  tabs: null,
  privacy: null,
  passwords: null,
  youtube: null,
  about: null,
  defaultBrowser: "general",
  language: "general",
  swipe: "general",
  appLinks: "general",
  customEngine: "search",
  wallpaper: "appearance",
  textSize: "appearance",
  archive: "tabs",
  startPage: "tabs",
};

/** The pages to open for a page: its parents first, so ‹ goes where it would have. */
export function pathTo(target: SettingsPage): SettingsPage[] {
  const path: SettingsPage[] = [];

  for (let at: SettingsPage | null = target; at; at = PARENT[at]) path.unshift(at);

  return path;
}
