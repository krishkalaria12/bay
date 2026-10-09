import type { BrowserState } from "./browser";
import { orderSections, syncGroupOrder } from "./groups";
import { IDLE_LIVE, makeTab, newId, pinnedPage } from "./model";
import { samePage } from "./organize";
import type { HeldPins } from "./parkedPins";
import { dataIdOf } from "./profiles";
import { removeTabs } from "./tabs";
import type { BrowserWindow, PinnedFolder, Tab } from "./types";

// As Arc's, pinned tabs are the space's and favourites the profile's, not a window's: every window shows the same
// ones. Each window has its own tab for a pin (its page loads in that window), tied to the others' by its key; what
// one window does to its pins (pinning, unpinning, moving, renaming, re-homing, its folders) is done in each other
// window with the space. A favourite is its profile's (every space sharing it lists it); a pinned row and a folder
// are their space's. A folder's being collapsed stays the window's.

export const pinKeyOf = (t: Pick<Tab, "id" | "pinKey">) => t.pinKey ?? t.id;
const folderKeyOf = (f: PinnedFolder) => f.key ?? f.id;

/** The windows that show the spaces' pins: not a private window or Little Bay. */
export const mirrorsPins = (w: BrowserWindow | undefined) => !!w && !w.incognito && w.kind !== "small";

type Pin = { key: string; row: boolean; folder: string | null; home: string; customTitle: string | null; customIcon: string | null; tabId: string };
type Folder = { key: string; name: string; icon: string | null; createdAt: number; collapsed: boolean };
type Layout = { pins: Pin[]; folders: Folder[] };
type View = { layouts: Map<string, Map<string, Layout>>; sigs: Map<string, Map<string, string>> };

const dataOf = (s: Pick<BrowserState, "profiles">, profileId: string) => {
  const p = s.profiles[profileId];
  return p ? dataIdOf(p) : undefined;
};

// A window's pins by scope: "t:<profile>" its favourites, "r:<space>" a space's pinned rows and folders. The window
// has the scopes of each space it has tabs of or shows, empty ones too.
function layoutsOf(s: BrowserState, w: BrowserWindow): Map<string, Layout> {
  const out = new Map<string, Layout>();
  const scope = (key: string) => {
    let layout = out.get(key);
    if (!layout) out.set(key, (layout = { pins: [], folders: [] }));
    return layout;
  };
  const joined = new Set<string>();
  const join = (profileId: string) => {
    if (joined.has(profileId)) return;
    joined.add(profileId);
    const data = dataOf(s, profileId);
    if (data === undefined) return;
    scope(`t:${data}`);
    scope(`r:${profileId}`);
  };
  join(w.profileId);
  const folders = new Map<string, PinnedFolder>();
  for (const f of Object.values(s.pinnedFolders)) if (f.windowId === w.id && s.profiles[f.profileId]) folders.set(f.id, f);
  for (const id of w.tabIds) {
    const t = s.tabs[id];
    if (!t) continue;
    join(t.profileId);
    const data = pinnedPage(t) ? dataOf(s, t.profileId) : undefined;
    if (data === undefined) continue;
    const folder = !t.pinned && t.folderId ? folders.get(t.folderId) : undefined;
    scope(t.pinned ? `t:${data}` : `r:${t.profileId}`).pins.push({
      key: pinKeyOf(t),
      row: !t.pinned,
      folder: folder && folder.profileId === t.profileId ? folderKeyOf(folder) : null,
      home: t.pinnedUrl || t.url,
      customTitle: t.customTitle,
      customIcon: t.customIcon,
      tabId: t.id,
    });
  }
  for (const f of folders.values()) {
    scope(`r:${f.profileId}`).folders.push({ key: folderKeyOf(f), name: f.name, icon: f.icon, createdAt: f.createdAt, collapsed: f.collapsed });
  }
  return out;
}

const SEP = "\u001f";
const sigOf = (l: Layout) =>
  l.pins.map((p) => [p.key, p.row ? 1 : 0, p.folder ?? "", p.home, p.customTitle ?? "", p.customIcon ?? ""].join(SEP)).join("\u001e") +
  "\u001d" +
  [...l.folders]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((f) => [f.key, f.name, f.icon ?? "", f.createdAt].join(SEP))
    .join("\u001e");

// The views of the last two states: a change's previous state is the one before's new state.
let cached: { state: BrowserState; view: View }[] = [];

function viewOf(s: BrowserState): View {
  const hit = cached.find((c) => c.state === s);
  if (hit) return hit.view;
  const view: View = { layouts: new Map(), sigs: new Map() };
  for (const w of Object.values(s.windows)) {
    if (!mirrorsPins(w)) continue;
    const layouts = layoutsOf(s, w);
    view.layouts.set(w.id, layouts);
    view.sigs.set(w.id, new Map([...layouts].map(([scope, l]) => [scope, sigOf(l)])));
  }
  cached = [{ state: s, view }, ...cached].slice(0, 2);
  return view;
}

// The layouts together: the first's pins and folders, then each other's that the ones before don't have (by key, or
// a page pinned the same way / a folder of the same name).
function merged(list: Layout[]): Layout {
  if (list.length === 1) return list[0]!;
  const pins: Pin[] = [];
  const folders: Folder[] = [];
  for (const l of list) {
    // A page or folder name matches only the earlier layouts': one layout's own two of them stay two.
    const earlierPins = pins.length;
    const earlierFolders = folders.slice();
    const folderKey = new Map<string, string>();
    for (const f of l.folders) {
      const same = folders.find((x) => x.key === f.key) ?? earlierFolders.find((x) => x.name === f.name);
      if (same) folderKey.set(f.key, same.key);
      else folders.push(f);
    }
    for (const p of l.pins) {
      const folder = p.folder ? (folderKey.get(p.folder) ?? p.folder) : null;
      const same = (x: Pin, i: number) => x.key === p.key || (i < earlierPins && x.row === p.row && x.folder === folder && samePage(x.home, p.home));
      if (!pins.some(same)) pins.push({ ...p, folder });
    }
  }
  return { pins, folders };
}

/**
 * The windows' pins made alike after a change: a window whose pins changed is the one the others follow; a window new
 * to a space (and a launch, when every window is) adds what it has that the others don't.
 */
export function mirrorPins(s: BrowserState, prev: BrowserState): BrowserState | null {
  if (s.tabs === prev.tabs && s.windows === prev.windows && s.pinnedFolders === prev.pinnedFolders && s.profiles === prev.profiles) return null;
  const was = viewOf(prev);
  const now = viewOf(s);
  if (now.layouts.size < 2) return null;
  const recency = [...s.ui.focusOrder, ...[...s.windowOrder].reverse()];
  const rank = (id: string) => {
    const i = recency.indexOf(id);
    return i < 0 ? recency.length : i;
  };
  const byRecency = (ids: string[]) => [...ids].sort((a, b) => rank(a) - rank(b));

  const plans = new Map<string, Map<string, Layout>>();
  const scopes = new Set([...now.layouts.values()].flatMap((m) => [...m.keys()]));
  for (const scope of scopes) {
    const members = byRecency([...now.layouts.keys()].filter((id) => now.layouts.get(id)!.has(scope)));
    if (members.length < 2) continue;
    const sig = (id: string) => now.sigs.get(id)!.get(scope)!;
    if (members.every((id) => sig(id) === sig(members[0]!))) continue;
    const before = (id: string) => was.sigs.get(id)?.get(scope);
    const changed = members.filter((id) => before(id) !== undefined && before(id) !== sig(id));
    const fresh = members.filter((id) => before(id) === undefined);
    const sources = changed.length ? [changed[0]!, ...fresh] : members;
    const layout = merged(sources.map((id) => now.layouts.get(id)!.get(scope)!));
    const want = sigOf(layout);
    for (const id of members) {
      if (sig(id) === want) continue;
      if (!plans.has(id)) plans.set(id, new Map());
      plans.get(id)!.set(scope, layout);
    }
  }
  let next = s;
  for (const [windowId, wanted] of plans) next = applyLayouts(next, windowId, now.layouts.get(windowId)!, wanted);
  return next === s ? null : next;
}

function applyLayouts(s: BrowserState, windowId: string, current: Map<string, Layout>, wanted: Map<string, Layout>): BrowserState {
  const w = s.windows[windowId];
  if (!w) return s;
  const tabs = { ...s.tabs };
  const live = { ...s.live };
  const pinnedFolders = { ...s.pinnedFolders };
  const placed: string[] = [];
  // The window's tabs for the pins of the scopes it takes: each is kept for the pin with its key (or its page), if
  // it's of the same profile (its page stays as it is).
  const pool = [...wanted.keys()].flatMap((scope) => current.get(scope)?.pins ?? []);
  const unused = new Set(pool.map((p) => p.tabId));
  const take = (p: Pin, data: string | undefined, folder: string | null) => {
    const free = pool.filter((x) => unused.has(x.tabId) && dataOf(s, tabs[x.tabId]!.profileId) === data);
    const found = free.find((x) => x.key === p.key) ?? free.find((x) => x.row === p.row && x.folder === folder && samePage(x.home, p.home));
    if (found) unused.delete(found.tabId);
    return found ? tabs[found.tabId] : undefined;
  };

  for (const [scope, layout] of wanted) {
    const space = scope.startsWith("r:") ? scope.slice(2) : null;
    const data = space ? dataOf(s, space) : scope.slice(2);
    const folderIds = new Map<string, string>();
    if (space) {
      const own = Object.values(s.pinnedFolders).filter((f) => f.windowId === windowId && f.profileId === space);
      const free = new Set(own.map((f) => f.id));
      for (const f of layout.folders) {
        const mine = own.find((x) => free.has(x.id) && folderKeyOf(x) === f.key) ?? own.find((x) => free.has(x.id) && x.name === f.name);
        const id = mine?.id ?? newId("pf");
        free.delete(id);
        const base: PinnedFolder = mine ? { ...mine } : { id, windowId, profileId: space, name: f.name, icon: f.icon, collapsed: f.collapsed, createdAt: f.createdAt };
        delete base.key;
        // Its createdAt places it as the others' when it's empty (components/sidebar/entries.ts).
        pinnedFolders[id] = { ...base, ...(f.key === id ? {} : { key: f.key }), name: f.name, icon: f.icon, createdAt: f.createdAt };
        folderIds.set(f.key, id);
      }
      for (const id of free) delete pinnedFolders[id];
    }
    for (const p of layout.pins) {
      const folderId = p.folder ? folderIds.get(p.folder) : undefined;
      const local = folderId && s.pinnedFolders[folderId] ? folderKeyOf(s.pinnedFolders[folderId]!) : null;
      const t = take(p, data, local);
      const id = t ? t.id : newId("tab");
      const shape = { pinned: !p.row, pinnedUrl: p.home || null, customTitle: p.customTitle, customIcon: p.customIcon };
      const marks = { ...(p.row ? { pinnedRow: true as const } : {}), ...(folderId ? { folderId } : {}), ...(p.key === id ? {} : { pinKey: p.key }) };
      if (t) {
        const { pinnedRow: _r, folderId: _f, pinKey: _k, ...rest } = t;
        const asleep = !t.navigation && !t.adoptId;
        const page = asleep && t.url && !samePage(t.url, p.home) ? pageOf(s, p, t.profileId) : {};
        tabs[id] = { ...rest, ...shape, ...marks, ...page, profileId: space ?? t.profileId };
      } else {
        const source = s.tabs[p.tabId];
        const owner = space ?? source?.profileId;
        if (!owner || !s.profiles[owner]) continue;
        tabs[id] = {
          ...makeTab(windowId, owner, p.home, { ...pageOf(s, p, owner), ...shape, muted: false, zoom: source?.zoom ?? 1 }),
          ...marks,
          id,
          navigation: null,
          unloaded: true,
        };
        live[id] = IDLE_LIVE;
      }
      placed.push(id);
    }
  }

  // A tab for a pin the window no longer has goes; one whose page is open stays, as a page.
  const gone: string[] = [];
  for (const id of unused) {
    const t = tabs[id]!;
    if (!t.navigation && !t.adoptId) gone.push(id);
    else {
      const { pinnedRow: _r, folderId: _f, pinKey: _k, ...rest } = t;
      tabs[id] = { ...rest, pinned: false, pinnedUrl: null };
    }
  }
  const first = new Set(placed);
  const window = { ...w, tabIds: orderSections([...placed, ...w.tabIds.filter((id) => !first.has(id) && tabs[id])], tabs, s.groups) };
  const next: BrowserState = {
    ...s,
    tabs,
    live,
    pinnedFolders,
    windows: { ...s.windows, [windowId]: window },
    groups: syncGroupOrder(s.groups, window),
  };
  return gone.length ? removeTabs(next, gone, false) : next;
}

// What a pin's tab shows before it loads: its page's title and icon, from its source tab or the history.
function pageOf(s: BrowserState, p: Pin, profileId: string): Pick<Tab, "url" | "title" | "favicon"> {
  const source = s.tabs[p.tabId];
  if (source && (!source.url || samePage(source.url, p.home))) return { url: p.home, title: source.title, favicon: source.favicon };
  const entry = (s.history[profileId] ?? []).find((h) => samePage(h.url, p.home));
  return { url: p.home, title: entry?.title ?? source?.title ?? "", favicon: entry?.favicon ?? source?.favicon ?? null };
}

/** Which spaces' pins the other windows have: closing this window parks only the rest (store/parkedPins.ts). */
export function pinsHeldElsewhere(s: BrowserState, windowId: string): HeldPins {
  const spaces = new Set<string>();
  for (const w of Object.values(s.windows)) {
    if (w.id === windowId || !mirrorsPins(w)) continue;
    spaces.add(w.profileId);
    for (const id of w.tabIds) if (s.tabs[id]) spaces.add(s.tabs[id]!.profileId);
  }
  const data = new Set([...spaces].map((p) => dataOf(s, p)).filter((d) => d !== undefined));
  return { tiles: (profileId) => data.has(dataOf(s, profileId) ?? ""), rows: (profileId) => spaces.has(profileId) };
}
