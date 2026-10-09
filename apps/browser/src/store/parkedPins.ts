import type { BrowserState } from "./browser";
import { orderSections, syncGroupOrder } from "./groups";
import { inFolder } from "./folders";
import { favoriteTabIds, IDLE_LIVE, makeTab, newId, pinnedFirst, sharesProfile, snapshotTab, without } from "./model";
import { samePage } from "./organize";
import type { BrowserWindow, HistoryEntry, ParkedPins, Tab, TabGroup } from "./types";


type PinSource = Pick<BrowserState, "tabs" | "groups" | "pinnedFolders" | "history">;

export function atPin(t: Tab, history: HistoryEntry[]): Partial<Pick<Tab, "url" | "title" | "favicon">> {
  const home = t.pinnedUrl;
  if (!home || !t.url || samePage(t.url, home)) return {};
  const entry = history.find((h) => samePage(h.url, home));
  return { url: home, title: entry?.title ?? t.title, favicon: entry?.favicon ?? t.favicon };
}

const homeOf = (t: { url: string; pinnedUrl?: string | null }) => t.pinnedUrl || t.url;

/** Which of a space's pins another window still has (store/mirroredPins.ts): those aren't parked. */
export type HeldPins = { tiles(profileId: string): boolean; rows(profileId: string): boolean };

export function parkWindowPins(parked: Record<string, ParkedPins>, w: BrowserWindow, s: PinSource, held?: HeldPins): Record<string, ParkedPins> {
  if (w.incognito) return parked;
  const groupOf = new Map<string, TabGroup>();
  for (const g of Object.values(s.groups)) if (g.pinned && g.windowId === w.id) for (const id of g.tabIds) groupOf.set(id, g);
  let next = parked;
  const profiles = new Set(w.tabIds.map((id) => s.tabs[id]?.profileId).filter((p): p is string => !!p));
  for (const profileId of profiles) {
    const tilesHeld = !!held?.tiles(profileId);
    const rowsHeld = !!held?.rows(profileId);
    const own = w.tabIds
      .map((id) => s.tabs[id])
      .filter((t): t is Tab => !!t && t.profileId === profileId && !(t.pinned && tilesHeld) && !(t.pinnedRow && rowsHeld));
    const folders = rowsHeld ? [] : Object.values(s.pinnedFolders).filter((f) => f.windowId === w.id && f.profileId === profileId);
    if (!own.some((t) => t.pinned || t.pinnedRow || groupOf.has(t.id)) && !folders.length) continue;
    const old = next[profileId] ?? { tabs: [], groups: [] };
    const ids = new Set(old.tabs.map((p) => p.id));
    // A page already parked as a tile isn't parked again as one, nor a loose pinned row's as a loose row.
    const homes = old.tabs.filter((p) => !p.groupId && !p.pinnedRow).map(homeOf);
    const rowHomes = old.tabs.filter((p) => p.pinnedRow && !p.folderId).map(homeOf);
    // A folder is parked by its key: each window's folder for it is the same one (store/mirroredPins.ts).
    const folderRows = old.tabs.filter((p) => p.pinnedRow && p.folderId).map((p) => `${p.folderId} ${homeOf(p)}`);
    const groups = [...old.groups];
    const parkedFolders = [...(old.folders ?? [])];
    for (const f of folders) {
      const key = f.key ?? f.id;
      if (!parkedFolders.some((x) => x.id === key)) parkedFolders.push({ id: key, name: f.name, icon: f.icon, collapsed: f.collapsed });
    }
    const tiles: ParkedPins["tabs"] = [];
    const rows: ParkedPins["tabs"] = [];
    const members: ParkedPins["tabs"] = [];
    for (const t of own) {
      if (ids.has(t.id)) continue;
      const g = t.pinned ? undefined : groupOf.get(t.id);
      if (t.pinned) {
        const tile = { ...snapshotTab(t), ...atPin(t, s.history[profileId] ?? []), id: t.id, groupId: null };
        if (homes.some((h) => samePage(h, homeOf(tile)))) continue;
        homes.push(homeOf(tile));
        tiles.push(tile);
      } else if (t.pinnedRow) {
        const folder = folders.find((f) => inFolder(t, f));
        const row = { ...snapshotTab(t), ...atPin(t, s.history[profileId] ?? []), id: t.id, groupId: null, ...(folder ? { folderId: folder.key ?? folder.id } : {}) };
        if (folder) {
          const place = `${row.folderId} ${homeOf(row)}`;
          if (folderRows.includes(place)) continue;
          folderRows.push(place);
        } else {
          if (rowHomes.some((h) => samePage(h, homeOf(row)))) continue;
          rowHomes.push(homeOf(row));
        }
        rows.push(row);
      } else if (g) {
        if (!groups.some((x) => x.id === g.id)) groups.push({ id: g.id, name: g.name, icon: g.icon, color: g.color, collapsed: g.collapsed });
        members.push({ ...snapshotTab(t), id: t.id, groupId: g.id });
      }
    }
    const oldTiles = old.tabs.filter((p) => !p.groupId && !p.pinnedRow);
    const oldRows = old.tabs.filter((p) => p.pinnedRow);
    const oldMembers = old.tabs.filter((p) => p.groupId);
    const park: ParkedPins = { tabs: [...oldTiles, ...tiles, ...oldRows, ...rows, ...oldMembers, ...members], groups };
    next = { ...next, [profileId]: parkedFolders.length ? { ...park, folders: parkedFolders } : park };
  }
  return next;
}

export function adoptParkedPins(s: BrowserState, windowId: string, profileId: string): BrowserState {
  return adoptSharedFavorites(adoptOwnPins(s, windowId, profileId), windowId, profileId);
}

function adoptOwnPins(s: BrowserState, windowId: string, profileId: string): BrowserState {
  const park = s.parkedPins[profileId];
  const w = s.windows[windowId];
  if (!park || !w || w.incognito || !s.profiles[profileId]) return s;
  const tabs = { ...s.tabs };
  const live = { ...s.live };
  const own = w.tabIds.map((id) => tabs[id]).filter((t): t is Tab => !!t && t.profileId === profileId);
  const homes = own.filter((t) => t.pinned).map(homeOf);
  const rowHomes = own.filter((t) => t.pinnedRow && !t.folderId).map(homeOf);
  // The parked folders come back, empty ones too, under new ids if theirs are taken.
  const pinnedFolders = { ...s.pinnedFolders };
  const folderIds = new Map<string, string>();
  for (const f of park.folders ?? []) {
    const id = pinnedFolders[f.id] ? newId("pf") : f.id;
    pinnedFolders[id] = { ...f, id, windowId, profileId, createdAt: Date.now() };
    folderIds.set(f.id, id);
  }
  const members = new Map<string, string[]>();
  const added: string[] = [];
  for (const { id, groupId, folderId: parkedFolder, ...snap } of park.tabs) {
    const home = homeOf(snap);
    const row = !groupId && !!snap.pinnedRow;
    const folderId = row && parkedFolder ? folderIds.get(parkedFolder) : undefined;
    if (!groupId && !row && homes.some((h) => samePage(h, home))) continue;
    if (row && !folderId && rowHomes.some((h) => samePage(h, home))) continue;
    const tab: Tab = {
      ...makeTab(windowId, profileId, snap.url, { ...snap, profileId, pinned: !groupId && !row, pinnedUrl: groupId ? null : home || null }),
      ...(folderId ? { folderId } : {}),
      id: tabs[id] ? newId("tab") : id,
      navigation: null,
      unloaded: true,
    };
    tabs[tab.id] = tab;
    live[tab.id] = IDLE_LIVE;
    added.push(tab.id);
    if (groupId) members.set(groupId, [...(members.get(groupId) ?? []), tab.id]);
  }
  let groups = { ...s.groups };
  for (const g of park.groups) {
    const tabIds = members.get(g.id);
    if (!tabIds?.length) continue;
    const id = groups[g.id] ? newId("g") : g.id;
    groups[id] = { ...g, id, windowId, profileId, pinned: true, tabIds, createdAt: Date.now() };
  }
  const window = { ...w, tabIds: orderSections(pinnedFirst([...added, ...w.tabIds], tabs), tabs, groups) };
  groups = syncGroupOrder(groups, window);
  return { ...s, tabs, live, groups, pinnedFolders, windows: { ...s.windows, [windowId]: window }, parkedPins: without(s.parkedPins, [profileId]) };
}

// Favourites parked by another space with this profile come back with this one: they're its favourites too. Each stays
// its own space's; a page the window's favourites already have isn't added twice. Pinned groups, pinned rows and
// folders stay parked.
function adoptSharedFavorites(s: BrowserState, windowId: string, profileId: string): BrowserState {
  const w = s.windows[windowId];
  if (!w || w.incognito || !s.profiles[profileId]) return s;
  const tabs = { ...s.tabs };
  const live = { ...s.live };
  let parkedPins = s.parkedPins;
  const homes = favoriteTabIds(s, windowId, profileId).map((id) => homeOf(tabs[id]!));
  const added: string[] = [];
  for (const [other, park] of Object.entries(s.parkedPins)) {
    if (other === profileId || !sharesProfile(s, other, profileId)) continue;
    const tiles = park.tabs.filter((p) => !p.groupId && !p.pinnedRow);
    if (!tiles.length) continue;
    for (const { id, groupId: _, ...snap } of tiles) {
      const home = homeOf(snap);
      if (homes.some((h) => samePage(h, home))) continue;
      homes.push(home);
      const tab: Tab = {
        ...makeTab(windowId, other, snap.url, { ...snap, profileId: other, pinned: true, pinnedUrl: home || null }),
        id: tabs[id] ? newId("tab") : id,
        navigation: null,
        unloaded: true,
      };
      tabs[tab.id] = tab;
      live[tab.id] = IDLE_LIVE;
      added.push(tab.id);
    }
    const kept = park.tabs.filter((p) => p.groupId || p.pinnedRow);
    parkedPins = kept.length || park.folders?.length ? { ...parkedPins, [other]: { ...park, tabs: kept } } : without(parkedPins, [other]);
  }
  if (parkedPins === s.parkedPins) return s;
  const window = { ...w, tabIds: orderSections(pinnedFirst([...added, ...w.tabIds], tabs), tabs, s.groups) };
  return { ...s, tabs, live, parkedPins, windows: { ...s.windows, [windowId]: window } };
}
