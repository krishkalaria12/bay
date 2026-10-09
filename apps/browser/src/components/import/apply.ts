import { savePassword } from "@bay/nncore";
import type { BookmarkNode as ImportedNode, Credential, DiaTabsProfile, ImportedTab, ImportKind, ImportResult, SafariExport, SpaceSuggestion } from "@bay/import";
import type { BookmarkDraft } from "../../store/bookmarks";
import { useBrowser } from "../../store/browser";
import { engineProfile, isIncognitoSpace, listIds, tabListKey } from "../../store/model";
import { withNewTab } from "../../store/tabs";
import type { SpaceColor } from "../../store/types";
import { importModule } from "./module";

export type ImportCounts = { bookmarks: number; history: number; tabs: number; passwords: number; cookies: number; addresses: number; cards: number };

export const emptyCounts = (): ImportCounts => ({ bookmarks: 0, history: 0, tabs: 0, passwords: 0, cookies: 0, addresses: 0, cards: 0 });

const toDraft = (n: ImportedNode): BookmarkDraft =>
  n.type === "url"
    ? { title: n.title || n.url || "", url: n.url ?? "", addedAt: n.dateAdded }
    : { title: n.title, addedAt: n.dateAdded, children: (n.children ?? []).map(toDraft) };

const linkCount = (nodes: ImportedNode[]): number => nodes.reduce((n, c) => n + (c.type === "url" ? 1 : linkCount(c.children ?? [])), 0);

export function importBookmarks(spaceId: string, root: ImportedNode | undefined, browserName: string): number {
  if (!root?.children?.length) return 0;
  if (!useBrowser.getState().bookmarks.roots[spaceId]) useBrowser.getState().addBookmarkTree(spaceId, []);
  const roots = useBrowser.getState().bookmarks.roots[spaceId]!;
  const toolbar = root.children.filter((c) => c.role === "toolbar").flatMap((c) => c.children ?? []);
  const rest = root.children.filter((c) => c.role !== "toolbar");
  const other = rest.flatMap((c) => (c.role === "other" || !c.role ? (c.type === "folder" ? (c.children ?? []) : [c]) : [c]));
  const title = `Imported from ${browserName}`;
  const place = (nodes: ImportedNode[], parentId: string) => {
    if (!nodes.length) return;
    const parent = useBrowser.getState().bookmarks.nodes[parentId];
    const empty = parent?.kind === "folder" && parent.children.length === 0;
    const drafts = nodes.map(toDraft);
    useBrowser.getState().addBookmarkTree(spaceId, empty ? drafts : [{ title, children: drafts }], parentId);
  };
  place(toolbar, roots.bar);
  place(other, roots.other);
  return linkCount([...toolbar, ...other]);
}

export function importSafariBookmarks(spaceId: string, root: ImportedNode | undefined): number {
  return importBookmarks(spaceId, root, "Safari");
}

export function importHistory(spaceId: string, entries: { url: string; title: string; visits: number; lastVisit: number }[]): number {
  const before = useBrowser.getState().history[spaceId]?.length ?? 0;
  useBrowser.getState().importHistory(spaceId, entries);
  return (useBrowser.getState().history[spaceId]?.length ?? 0) - before;
}

export async function importPasswords(spaceId: string, credentials: Credential[]): Promise<number> {
  let saved = 0;
  for (const c of credentials) {
    const origin = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i.exec(c.realm?.startsWith("http") ? c.realm : c.url)?.[1];
    if (!origin || !c.password) continue;
    if (await savePassword(engineProfile(spaceId), origin, c.username, c.password).catch(() => false)) saved++;
  }
  return saved;
}

/** Writes the cookies, addresses and cards an import kept natively (their values never reach JS) into the profile.
 * Never into a private profile: the token is dropped instead. `onFailed` hears the kinds the engine refused. */
export async function importNative(
  spaceId: string,
  token: string | undefined,
  kinds: ("cookies" | "autofill")[],
  onFailed?: (kind: ImportKind) => void,
): Promise<Pick<ImportCounts, "cookies" | "addresses" | "cards">> {
  const none = { cookies: 0, addresses: 0, cards: 0 };
  const api = importModule();
  if (!api || !token) return none;
  if (!kinds.length || isIncognitoSpace(spaceId) || useBrowser.getState().spaces[spaceId] === undefined) {
    api.discardImported(token);
    return none;
  }
  try {
    const w = await api.writeImported(token, engineProfile(spaceId), kinds);
    if (w.cookiesFailed) onFailed?.("cookies");
    if (w.autofillFailed) onFailed?.("autofill");
    return { cookies: w.cookies, addresses: w.addresses, cards: w.cards };
  } catch {
    kinds.forEach((k) => onFailed?.(k));
    return none;
  }
}

function windowFor(spaceId: string): string {
  const s = useBrowser.getState();
  const regular = s.ui.focusOrder.find((id) => s.windows[id] && !s.windows[id]!.incognito) ?? s.windowOrder.find((id) => !s.windows[id]!.incognito);
  return regular ?? s.createWindow({ spaceId });
}

/** Opens each extension's Chrome Web Store page in the profile, where the user adds the ones they want. */
export function openInWebStore(spaceId: string, urls: string[]) {
  if (!urls.length) return;
  const windowId = windowFor(spaceId);
  urls.forEach((url, i) => useBrowser.getState().newTab(windowId, { url, spaceId, background: i > 0 }));
}

type TabDraft = Pick<ImportedTab, "url" | "title" | "pinned" | "customTitle">;

const usable = (t: TabDraft) => /^(https?|file):/.test(t.url);

/** Opens the tabs in the profile's window, unpinned ones in order after each other; the ids line up with `tabs`. */
function openTabs(spaceId: string, tabs: TabDraft[]): (string | null)[] {
  const windowId = windowFor(spaceId);
  let s = useBrowser.getState();
  let last: string | undefined;
  const ids = tabs.map((t) => {
    const after = t.pinned ? undefined : last;
    const [next, id] = withNewTab(s, windowId, {
      url: t.url,
      spaceId,
      background: true,
      pinned: t.pinned,
      snapshot: { title: t.title, customTitle: t.customTitle ?? null },
      index: after ? listIds(s, tabListKey(s, s.tabs[after]!)).indexOf(after) + 1 : undefined,
    });
    if (!id) return null;
    s = { ...next, tabs: { ...next.tabs, [id]: { ...next.tabs[id]!, navigation: null } } };
    if (!t.pinned) last = id;
    return id;
  });
  useBrowser.setState(s);
  return ids;
}

export function importTabs(spaceId: string, tabs: TabDraft[], group: string | null): number {
  const fresh = tabs.filter(usable);
  if (!fresh.length) return 0;
  const ids = openTabs(spaceId, fresh);
  const unpinned = ids.filter((id, i): id is string => !!id && !fresh[i]!.pinned);
  if (group && unpinned.length) useBrowser.getState().createGroup(unpinned, { name: group });
  return fresh.length;
}

/** A space's pinned tabs become the Pinned section's rows, in Arc's order, and its folders the section's folders.
 * Bay's folders don't nest: a folder inside one gives its tabs to the outer one. */
export function importArcSpace(spaceId: string, space: SpaceSuggestion): number {
  const links = (n: ImportedNode): ImportedNode[] => (n.type === "url" ? (n.url ? [n] : []) : (n.children ?? []).flatMap(links));
  const asTab = (n: ImportedNode): TabDraft => ({ url: n.url!, title: n.pageTitle ?? n.title, pinned: false, customTitle: n.pageTitle ? n.title : undefined });
  const entries = space.pinned.map((n) => ({ folder: n.type === "folder" ? n.title : null, tabs: links(n).map(asTab).filter(usable) }));
  const ids = openTabs(spaceId, entries.flatMap((e) => e.tabs));
  const rows = ids.filter((id): id is string => !!id);
  if (rows.length) useBrowser.getState().pinRows(rows, true);
  const windowId = rows.length ? useBrowser.getState().tabs[rows[0]!]!.windowId : windowFor(spaceId);
  let at = 0;
  for (const e of entries) {
    const members = ids.slice(at, (at += e.tabs.length)).filter((id): id is string => !!id);
    if (e.folder !== null) useBrowser.getState().newPinnedFolder(windowId, { tabIds: members, name: e.folder });
  }
  return rows.length + importTabs(spaceId, space.tabs.map((t) => ({ ...t, pinned: false })), "Imported");
}

function pageKey(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(url.trim());
  if (!m) return url;
  const rest = m[3]!.startsWith("/") ? m[3]! : `/${m[3]}`;
  return `${m[1]!.toLowerCase()}${m[2]!.toLowerCase()}${rest.replace(/#$/, "")}`;
}

export function importDiaProfile(spaceId: string, profile: DiaTabsProfile, what: { pinned: boolean; open: boolean }): number {
  const have = new Set(
    Object.values(useBrowser.getState().tabs)
      .filter((t) => t.spaceId === spaceId)
      .flatMap((t) => [t.url, t.pinnedUrl ?? ""].filter(Boolean).map(pageKey)),
  );
  const fresh = (tabs: ImportedTab[]) => tabs.filter((t) => !have.has(pageKey(t.url)));
  let n = what.pinned ? importTabs(spaceId, fresh(profile.pinned), null) : 0;
  if (what.open) n += importTabs(spaceId, fresh(profile.tabs).map((t) => ({ ...t, pinned: false })), "Imported");
  return n;
}

export async function applyResult(
  spaceId: string,
  result: ImportResult,
  browserName: string,
  onFailed?: (kind: ImportKind) => void,
): Promise<ImportCounts> {
  const counts = emptyCounts();
  counts.bookmarks += importBookmarks(spaceId, result.bookmarks, browserName);
  if (result.history.length) counts.history += importHistory(spaceId, result.history);
  // Sign-ins first, so the imported tabs load signed in.
  Object.assign(counts, await importNative(spaceId, result.vaultToken, ["cookies", "autofill"], onFailed));
  if (result.tabs.length && !result.spaces.length) counts.tabs += importTabs(spaceId, result.tabs, "Imported");
  if (result.favorites.length) counts.tabs += importTabs(spaceId, result.favorites.map((t) => ({ ...t, pinned: true })), null);
  if (result.credentials.length) counts.passwords += await importPasswords(spaceId, result.credentials);
  return counts;
}

/** `cookies`: whether the user kept Safari's cookies ticked (the export file has none; its cards always come). */
export async function applySafari(spaceId: string, data: SafariExport, cookies = true, onFailed?: (kind: ImportKind) => void): Promise<ImportCounts> {
  const counts = emptyCounts();
  counts.bookmarks = importSafariBookmarks(spaceId, data.bookmarks);
  const history = data.profiles.find((p) => !p.name)?.history ?? data.profiles[0]?.history ?? [];
  counts.history = importHistory(spaceId, history);
  Object.assign(counts, await importNative(spaceId, data.vaultToken, cookies ? ["cookies", "autofill"] : ["autofill"], onFailed));
  if (data.tabs.length) counts.tabs += importTabs(spaceId, data.tabs, "Imported");
  counts.passwords = await importPasswords(spaceId, data.credentials);
  return counts;
}

export function profileColorFor(hex: string | undefined): SpaceColor | undefined {
  const m = hex && /^#?([0-9a-f]{6})/i.exec(hex);
  if (!m) return undefined;
  const v = parseInt(m[1]!, 16);
  const [r, g, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.08) return "neutral";
  let h = 0;
  if (max === r) h = ((g - b) / (max - min) + 6) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h *= 60;
  const hues: [SpaceColor, number][] = [
    ["red", 0],
    ["orange", 25],
    ["yellow", 45],
    ["green", 140],
    ["blue", 210],
    ["purple", 265],
    ["pink", 330],
    ["red", 360],
  ];
  return hues.reduce((best, c) => (Math.abs(c[1] - h) < Math.abs(best[1] - h) ? c : best))[0];
}
