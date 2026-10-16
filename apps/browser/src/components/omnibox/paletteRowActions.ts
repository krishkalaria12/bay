import { hostOf, parseUrl, type Suggestion } from "@bay/core";
import type { Disposition } from "./open";
import type { PaletteMenuAction } from "./PaletteActionMenu";
import type { PaletteSuggestion } from "./paletteStart";

export type RowActionHandlers = {
  choose(s: Suggestion, disposition?: Disposition): void;
  openInBackground(url: string): void;
  copyLink(url: string): void;
  closeTab(tabId: string): void;
  forget(s: PaletteSuggestion): void;
};

const queryKeys = (query: string) =>
  query
    .replace(/^\?/, "")
    .split("&")
    .map((pair) => pair.split("=")[0]);

// A search engine's results page (google.com/search?q=…) reads as a search, so it isn't offered as a page to forget.
export function isSearchResultsPage(url: string, templates: readonly string[]): boolean {
  const page = parseUrl(url);
  if (!page) return false;
  return templates.some((template) => {
    const engine = parseUrl(template);
    if (!engine || hostOf(template) !== hostOf(url)) return false;
    const key = queryKeys(engine.query).find((k) => engine.query.includes(`${k}=%s`));
    if (key) return engine.path === page.path && queryKeys(page.query).includes(key);
    const at = engine.path.indexOf("%s");
    return at >= 0 && page.path.startsWith(engine.path.slice(0, at)) && page.path.length > at;
  });
}

// A history page (or a frequent site) the palette can forget; open tabs close instead, cleaned up tabs restore, and
// searches have nothing to forget.
export const forgettable = (s: PaletteSuggestion | undefined, searchTemplates: readonly string[] = []): boolean =>
  s?.kind === "page" && !s.tabId && !s.cleanedId && (!!s.host || (!!s.visited && !isSearchResultsPage(s.url, searchTemplates)));

// What ↩ does to the row: its menu's first action.
function primaryTitle(target: PaletteSuggestion, newTabPanel: boolean): string {
  if (target.kind === "page" && target.tabId) return "Switch to Tab";
  if (target.kind === "page" && target.cleanedId) return "Restore Tab";
  if (target.kind === "calc") return "Copy Answer";
  if (target.kind === "emoji") return "Copy Emoji";
  if (target.kind === "action") return target.title;
  return newTabPanel ? "Open in New Tab" : "Open";
}

// The ⌘K menu for a palette row. In the new tab panel ↩ already opens a new tab, so ⌘↩ opens one behind it.
export function rowMenuActions(
  target: PaletteSuggestion,
  newTabPanel: boolean,
  searchTemplates: readonly string[],
  run: RowActionHandlers,
): PaletteMenuAction[] {
  const tab = target.kind === "page" ? target.tabId : undefined;
  const actions: PaletteMenuAction[] = [
    {
      id: "open",
      title: primaryTitle(target, newTabPanel),
      icon: target.kind === "action" ? (target.icon ?? "command") : target.kind === "emoji" ? "doc.on.doc" : "arrow.up.right",
      hint: "↩",
      run: () => run.choose(target),
    },
  ];
  if (!("url" in target)) return actions;
  const url = target.url;
  if (!newTabPanel)
    actions.push({ id: "newTab", title: "Open in New Tab", icon: "plus.square.on.square", hint: "⌘↩", run: () => run.choose(target, "newTab") });
  actions.push(
    { id: "background", title: "Open in Background Tab", icon: "plus", hint: newTabPanel ? "⌘↩" : undefined, run: () => run.openInBackground(url) },
    { id: "copy", title: "Copy Link", icon: "link", hint: "⇧⌘C", run: () => run.copyLink(url) },
  );
  if (tab) actions.push({ id: "close", title: "Close Tab", icon: "xmark", separator: true, run: () => run.closeTab(tab) });
  else if (forgettable(target, searchTemplates))
    actions.push({
      id: "forget",
      title: target.host ? "Forget This Site" : "Forget This Page",
      icon: "trash",
      hint: "⇧⌫",
      separator: true,
      run: () => run.forget(target),
    });
  return actions;
}
