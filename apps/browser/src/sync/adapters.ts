import { withoutSidebarUndo } from "../store/sidebarUndo";
import { addHistoryVisits, deleteHistoryUrls, deletePassword, savePassword } from "@bay/nncore";
import { assignPositions, SyncNative, type Adapter, type Extraction, type SavedLogin } from "@bay/sync";
import { bookmarkUuidFor, ensureRoots, isBookmarkUuid } from "../store/bookmarks";
import { DEFAULT_SPACE_ID, MAX_HISTORY, MAX_VISIT_TIMES } from "../store/constants";
import { useBrowser } from "../store/browser";
import { normalizePinnedFolders, prunePinnedFolders } from "../store/folders";
import { orderSections, syncGroupOrder } from "../store/groups";
import { engineProfile, IDLE_LIVE, listIds, makeTab, pinnedFirst, spaceListKey, withList } from "../store/model";
import { removeTabs } from "../store/tabs";
import type { Settings } from "../store/settings";
import type { BookmarkNode, HistoryEntry, PinnedFolder, Space, Tab, TabGroup } from "../store/types";
import { HISTORY_WINDOW_MS, MAX_DEVICE_TABS, PASSWORD_READ_INTERVAL_MS, SAME_VISIT_MS } from "./constants";

const store = () => useBrowser.getState();

// MARK: App scope: settings, profiles, devices

export const SYNCED_SETTINGS = [
  "warnBeforeQuitting",
  "warnBeforeClosingWindow",
  "searchEngine",
  "searchShortcutMode",
  "customSearchUrl",
  "customSearchEngines",
  "searchSuggestions",
  "calculatorEnabled",
  "commandBarPreference",
  "tabLayout",
  "hideToolbarWhileScrolling",
  "newTabPosition",
  "warnBeforeClosingLastTab",
  "warnBeforeMovingTabsToSpace",
  "tabReorderHaptics",
  "extendWebsiteColor",
  "cmdClickCreatesTabGroup",
  "optShiftClickOpensInGroup",
  "autoGroupMeetingTabs",
  "tidyTabTitles",
  "tidyTabs",
  "cleanUpInactiveTabsAfterHours",
  "awakeSites",
  "tidyDownloads",
  "mutedSites",
  "autoPictureInPicture",
  "noAutoPictureInPictureSites",
  "previewFolders",
  "previewGmail",
  "previewGithub",
  "showFullUrl",
  "bookmarksBar",
  "appearance",
  "density",
  "addressBar",
  "sidebarPosition",
  "shortcuts",
] as const satisfies readonly (keyof Settings)[];

export const settingsAdapter: Adapter = {
  prefix: "set:",
  adoptRemoteOnJoin: true,
  extract: () => {
    const settings = store().settings;
    return { values: new Map(SYNCED_SETTINGS.map((name) => [`set:${name}`, { v: settings[name] ?? null }])) };
  },
  apply: (visible, changed) => {
    const patch: Record<string, unknown> = {};
    for (const key of changed) {
      const name = key.slice(4);
      const record = visible.get(key) as { v: unknown } | undefined;
      if (!record || !("v" in record) || !(SYNCED_SETTINGS as readonly string[]).includes(name)) continue;
      if (name === "awakeSites" && !Array.isArray(record.v)) continue;
      if (name === "density" && record.v !== "comfortable" && record.v !== "compact") continue;
      if (name === "searchShortcutMode" && record.v !== "arc" && record.v !== "duckduckgo") continue;
      if (name === "calculatorEnabled" && typeof record.v !== "boolean") continue;
      if (name === "tidyDownloads" && typeof record.v !== "boolean") continue;
      if (name === "tidyTabs" && typeof record.v !== "boolean") continue;
      patch[name] = record.v;
    }
    if (Object.keys(patch).length) store().updateSettings(patch as Partial<Settings>);
  },
};

export type ProfileRecord = { n: string; c: Space["color"]; i: string | null; d?: true; f?: boolean };

export function profilesAdapter(links: () => Record<string, { syncId: string }>): Adapter {
  const linked = () => Object.entries(links()).filter(([id]) => store().spaces[id]);
  return {
    prefix: "prof:",
    adoptRemoteOnJoin: true,
    extract: () => {
      const values = new Map<string, unknown>();
      for (const [id, { syncId }] of linked()) {
        const p = store().spaces[id]!;
        values.set(`prof:${syncId}`, {
          n: p.name,
          c: p.color,
          i: p.icon,
          f: !!p.folded,
          ...(id === DEFAULT_SPACE_ID ? { d: true } : {}),
        } satisfies ProfileRecord);
      }
      const mine = new Set(values.keys());
      return { values, ignore: (key) => !mine.has(key) };
    },
    apply: (visible, changed) => {
      for (const [id, { syncId }] of linked()) {
        const record = visible.get(`prof:${syncId}`) as ProfileRecord | undefined;
        if (!record || !changed.has(`prof:${syncId}`)) continue;
        withoutSidebarUndo(() =>
          store().updateSpace(id, { name: record.n, color: record.c, icon: record.i, ...(typeof record.f === "boolean" ? { folded: record.f } : {}) }),
        );
      }
    },
  };
}

export type DeviceRecord = { n: string };

export function deviceAdapter(deviceId: string, name: () => string, retired = false): Adapter {
  return {
    prefix: "dev:",
    extract: () => ({
      values: retired ? new Map() : new Map([[`dev:${deviceId}`, { n: name() } satisfies DeviceRecord]]),
      ignore: (key) => key !== `dev:${deviceId}`,
    }),
    apply: () => true,
  };
}

// MARK: Profile scope

type BookmarkValue = { k: "u" | "f"; p: string; t: string; u?: string; a: number; pos: string };

// A bookmark's record key is its sync key: Chrome's UUID, or for a bookmark synced before Chrome kept bookmarks,
// its old id (kept on Chrome's node as `syncKey`), so Macs not yet updated and updated ones name it alike. A key
// that isn't a UUID becomes the node bookmarkUuidFor gives, on every Mac.
export function bookmarksAdapter(spaceId: string): Adapter {
  // Before the tree is read from Chrome it's empty, which would read as every bookmark deleted.
  const ready = () => !!store().bookmarksReady[spaceId];
  return {
    prefix: "bm:",
    extract: (base) => {
      if (!ready()) return null;
      const b = store().bookmarks;
      const roots = b.roots[spaceId];
      const values = new Map<string, unknown>();
      if (!roots) return { values };
      // An old key names this node only if it maps to it (a copy of a bookmark carries its original's key along).
      const keyOf = (id: string) => {
        if (id === roots.bar) return "bar";
        if (id === roots.other) return "other";
        const key = b.nodes[id]?.syncKey;
        return key && bookmarkUuidFor(key) === id ? key : id;
      };
      const seen = new Set<string>();
      const walk = (folderId: string) => {
        const folder = b.nodes[folderId];
        if (folder?.kind !== "folder" || seen.has(folderId)) return;
        seen.add(folderId);
        const parent = keyOf(folderId);
        const children = folder.children.filter((id) => b.nodes[id]);
        const positions = assignPositions(
          children.map((id) => {
            const known = base(`bm:${keyOf(id)}`) as BookmarkValue | undefined;
            return known?.p === parent ? known.pos : undefined;
          }),
        );
        children.forEach((id, i) => {
          const node = b.nodes[id]!;
          values.set(`bm:${keyOf(id)}`, {
            k: node.kind === "url" ? "u" : "f",
            p: parent,
            t: node.title,
            ...(node.kind === "url" ? { u: node.url } : {}),
            a: node.addedAt,
            pos: positions[i]!,
          } satisfies BookmarkValue);
          if (node.kind === "folder") walk(id);
        });
      };
      walk(roots.bar);
      walk(roots.other);
      return { values };
    },
    apply: (visible) => {
      if (!ready()) return false;
      const s = store();
      const [b, roots] = ensureRoots(s.bookmarks, spaceId);
      // By node id; a key that isn't a UUID names the node bookmarkUuidFor gives it.
      const values = new Map([...visible].map(([k, v]) => [bookmarkUuidFor(k.slice(3)), v as BookmarkValue]));
      const keys = new Map([...visible.keys()].map((k) => [bookmarkUuidFor(k.slice(3)), k.slice(3)]));
      const rootOf = (key: string) => (key === "bar" ? roots.bar : key === "other" ? roots.other : null);
      const parentOf = new Map<string, string>();
      for (const [id, v] of values) {
        const root = rootOf(v.p);
        const parent = root ? null : bookmarkUuidFor(v.p);
        parentOf.set(id, root ?? (parent && values.get(parent)?.k === "f" ? parent : roots.other));
      }
      for (const id of [...values.keys()].sort()) {
        const seen = new Set<string>([id]);
        for (let at = parentOf.get(id)!; parentOf.has(at); at = parentOf.get(at)!) {
          if (seen.has(at)) {
            parentOf.set(id, roots.other);
            break;
          }
          seen.add(at);
        }
      }
      const children = new Map<string, string[]>([
        [roots.bar, []],
        [roots.other, []],
      ]);
      for (const id of values.keys()) children.set(parentOf.get(id)!, [...(children.get(parentOf.get(id)!) ?? []), id]);
      const byPosition = (a: string, z: string) => {
        const pa = values.get(a)!.pos;
        const pz = values.get(z)!.pos;
        const ka = keys.get(a)!;
        const kz = keys.get(z)!;
        return pa < pz ? -1 : pa > pz ? 1 : ka < kz ? -1 : 1;
      };
      const nodes: Record<string, BookmarkNode> = { ...b.nodes };
      const drop = (id: string) => {
        const node = nodes[id];
        if (node?.kind === "folder") node.children.forEach(drop);
        if (id !== roots.bar && id !== roots.other) delete nodes[id];
      };
      drop(roots.bar);
      drop(roots.other);
      for (const [id, v] of values) {
        const old = b.nodes[id];
        const key = keys.get(id)!;
        const syncKey = isBookmarkUuid(key) ? {} : { syncKey: key };
        nodes[id] =
          v.k === "u"
            ? {
                kind: "url",
                id,
                parentId: parentOf.get(id)!,
                title: v.t,
                url: v.u ?? "",
                favicon: old?.kind === "url" ? old.favicon : null,
                addedAt: v.a,
                ...syncKey,
              }
            : { kind: "folder", id, parentId: parentOf.get(id)!, title: v.t, children: [], addedAt: v.a, ...syncKey };
      }
      for (const [parent, ids] of children) {
        const folder = nodes[parent];
        if (folder?.kind === "folder") nodes[parent] = { ...folder, children: ids.sort(byPosition) };
      }
      useBrowser.setState({ bookmarks: { ...b, nodes } });
    },
  };
}

type HistoryValue = { t: string; n: number; vt: number[] };
const lastVisitOf = (v: HistoryValue) => Math.max(0, ...v.vt);
// What Chrome keeps in history (an app page, bay://, it doesn't): other records are left alone.
const keptInHistory = (url: string) => /^(https?|file):/i.test(url);

export const historyExpired = (key: string, value: unknown, now: number) =>
  key.startsWith("h:") && lastVisitOf(value as HistoryValue) < now - HISTORY_WINDOW_MS;

// History is Chrome's (lib/history.ts keeps the store's view of it). Applying a record adds its visits to
// Chrome, so Chrome's copy then differs from the record (its own visit count and title). A local edit is a visit
// the record doesn't have; anything else publishes the record unchanged. Two Macs settle on the union of their
// visits instead of trading versions.
export function historyAdapter(spaceId: string): Adapter {
  const ready = () => !!store().historyReady[spaceId];
  return {
    prefix: "h:",
    extract: (base) => {
      // Before the view is read from Chrome it's empty, which would read as every URL deleted.
      if (!ready()) return null;
      const since = Date.now() - HISTORY_WINDOW_MS;
      const values = new Map<string, unknown>();
      const older = new Set<string>();
      const view = store().history[spaceId] ?? [];
      // The view holds Chrome's newest MAX_HISTORY URLs: one visited at or before this may only be missing from it.
      const floor = store().historyFloor[spaceId] ?? -Infinity;
      for (const e of view) {
        if (!keptInHistory(e.url)) continue;
        const key = `h:${e.url}`;
        if (e.lastVisit < since) {
          older.add(key);
          continue;
        }
        const local: HistoryValue = { t: e.title, n: e.visits, vt: e.visitTimes?.length ? e.visitTimes : [e.lastVisit] };
        const known = base(key) as HistoryValue | undefined;
        const edited = !known || local.vt.some((t) => !known.vt.some((k) => Math.abs(k - t) <= SAME_VISIT_MS));
        values.set(key, edited ? local : known);
      }
      const ignore = (key: string) => {
        if (older.has(key) || !keptInHistory(key.slice(2))) return true;
        // Chrome expired it (as every Mac does), or the view no longer reaches it: not a deletion.
        const known = base(key) as HistoryValue | undefined;
        return !!known && (lastVisitOf(known) < since || lastVisitOf(known) <= floor);
      };
      return { values, ignore };
    },
    editedAt: (v) => lastVisitOf(v as HistoryValue),
    apply: async (visible, changed) => {
      if (!ready()) return false;
      const since = Date.now() - HISTORY_WINDOW_MS;
      const byUrl = new Map((store().history[spaceId] ?? []).map((e) => [e.url, e]));
      const add: { url: string; title: string; visitTimes: number[] }[] = [];
      const remove: string[] = [];
      const updates = new Map<string, HistoryEntry | null>();
      for (const key of changed) {
        const url = key.slice(2);
        if (!keptInHistory(url)) continue;
        const v = visible.get(key) as HistoryValue | undefined;
        const old = byUrl.get(url);
        if (v) {
          const have = old?.visitTimes ?? [];
          const fresh = v.vt.filter((t) => t >= since && !have.some((h) => Math.abs(h - t) <= SAME_VISIT_MS));
          if (fresh.length) add.push({ url, title: v.t, visitTimes: fresh });
          const times = [...have, ...fresh].sort((a, z) => a - z).slice(-MAX_VISIT_TIMES);
          if (!times.length) continue;
          updates.set(url, {
            url,
            title: v.t || old?.title || "",
            favicon: null,
            visits: Math.max(v.n, old?.visits ?? 0),
            lastVisit: times[times.length - 1]!,
            visitTimes: times,
          });
        } else if (old && old.lastVisit >= since) {
          remove.push(url);
          updates.set(url, null);
        }
      }
      if (!updates.size) return;
      const engine = engineProfile(spaceId);
      await Promise.all([addHistoryVisits(engine, add, SAME_VISIT_MS), deleteHistoryUrls(engine, remove)]);
      // The view as it is now (Chrome's reports may have landed meanwhile), with the records merged in.
      useBrowser.setState((s) => {
        const current = new Map((s.history[spaceId] ?? []).map((e) => [e.url, e]));
        for (const [url, update] of updates) {
          const now = current.get(url);
          if (!update) current.delete(url);
          else if (!now) current.set(url, update);
          else {
            const times = [...new Set([...(now.visitTimes ?? []), ...(update.visitTimes ?? [])])].sort((a, z) => a - z).slice(-MAX_VISIT_TIMES);
            current.set(url, { ...update, visits: Math.max(now.visits, update.visits), lastVisit: times[times.length - 1]!, visitTimes: times });
          }
        }
        const list = [...current.values()].sort((a, z) => z.lastVisit - a.lastVisit).slice(0, MAX_HISTORY);
        return { history: { ...s.history, [spaceId]: list } };
      });
    },
  };
}

export type DeviceTabs = { n: string; tabs: { u: string; t: string }[] };

export function deviceTabsAdapter(spaceId: string, deviceId: string, name: () => string, retired = false): Adapter {
  const key = `tabs:${deviceId}`;
  return {
    prefix: "tabs:",
    extract: () => {
      if (retired) return { values: new Map(), ignore: (k) => k !== key };
      const s = store();
      const open = Object.values(s.tabs)
        // Pinned tabs sync as pinned tabs; unloaded tiles and peeks aren't open.
        .filter((t) => t.spaceId === spaceId && !t.pinned && !t.unloaded && !t.peekOf && /^(https?|file):/.test(t.url) && !s.windows[t.windowId]?.incognito)
        .sort((a, z) => z.lastActiveAt - a.lastActiveAt)
        .slice(0, MAX_DEVICE_TABS)
        .map((t) => ({ u: t.url, t: t.customTitle || t.title }));
      return { values: new Map([[key, { n: name(), tabs: open } satisfies DeviceTabs]]), ignore: (k) => k !== key };
    },
    apply: () => true,
  };
}

type PinValue = { g: string | null; u: string; t: string | null; i: string | null; ti: string; pos: string; r?: true; o?: string };
// Optional folder metadata keeps these records readable as flat pinned groups on older devices.
type PinGroupValue = { n: string; i: string | null; c: TabGroup["color"]; pos: string; f?: true; p?: string | null; b?: string | null; a?: number };

export function pinnedAdapter(spaceId: string): Adapter {
  return {
    prefix: "pin:",
    extract: (base) => {
      const s = store();
      type Pin = Pick<Tab, "id" | "url" | "title" | "customTitle" | "customIcon" | "pinnedRow"> & { pinnedUrl?: string | null };
      const tiles: Pin[] = [];
      const groups: (Pick<TabGroup, "id" | "name" | "icon" | "color"> | PinnedFolder)[] = [];
      const members = new Map<string, Pin[]>();
      const pinnedGroupOf = new Map<string, TabGroup>();
      for (const g of Object.values(s.groups)) if (g.pinned && g.spaceId === spaceId) g.tabIds.forEach((id) => pinnedGroupOf.set(id, g));
      // The space's tiles and pinned groups, in its list's order.
      for (const id of listIds(s, spaceListKey(s, spaceId))) {
        const t = s.tabs[id];
        if (!t || t.spaceId !== spaceId) continue;
        const g = pinnedGroupOf.get(id);
        const folder = t.pinnedRow && t.folderId ? s.pinnedFolders[t.folderId] : undefined;
        if (t.pinned || (t.pinnedRow && !folder)) tiles.push(t);
        else if (folder) {
          if (!members.has(folder.id)) {
            members.set(folder.id, []);
            groups.push(folder);
          }
          members.get(folder.id)!.push(t);
        } else if (g) {
          if (!members.has(g.id)) {
            members.set(g.id, []);
            groups.push(g);
          }
          members.get(g.id)!.push(t);
        }
      }
      for (const folder of Object.values(s.pinnedFolders)) {
        if (folder.spaceId !== spaceId || members.has(folder.id)) continue;
        groups.push(folder);
        members.set(folder.id, []);
      }
      const rowIds = listIds(s, spaceListKey(s, spaceId)).filter((id) => s.tabs[id]?.spaceId === spaceId && s.tabs[id]?.pinnedRow);
      const rowOrder = assignPositions(rowIds.map((id) => (base(`pin:t:${id}`) as PinValue | undefined)?.o));
      const rowPositions = new Map(rowIds.map((id, index) => [id, rowOrder[index]!]));
      const values = new Map<string, unknown>();
      const place = (tabs: Pin[], group: string | null) => {
        const positions = assignPositions(
          tabs.map((t) =>
            ((base(`pin:t:${t.id}`) as PinValue | undefined)?.g ?? null) === group ? (base(`pin:t:${t.id}`) as PinValue | undefined)?.pos : undefined,
          ),
        );
        tabs.forEach((t, i) =>
          values.set(`pin:t:${t.id}`, {
            g: group,
            u: (group && !t.pinnedRow ? t.url : t.pinnedUrl || t.url) || "",
            t: t.customTitle,
            i: t.customIcon,
            ti: t.title,
            pos: positions[i]!,
            ...(t.pinnedRow ? { r: true, o: rowPositions.get(t.id)! } : {}),
          } satisfies PinValue),
        );
      };
      place(tiles, null);
      const groupPositions = assignPositions(groups.map((g) => (base(`pin:g:${g.id}`) as PinGroupValue | undefined)?.pos));
      groups.forEach((g, i) => {
        const folder = s.pinnedFolders[g.id];
        values.set(`pin:g:${g.id}`, {
          n: g.name,
          i: g.icon,
          c: "color" in g ? g.color : null,
          pos: groupPositions[i]!,
          ...(folder ? { f: true, p: folder.parentId ?? null, b: folder.beforeId ?? null, a: folder.createdAt } : {}),
        } satisfies PinGroupValue);
        place(members.get(g.id)!, g.id);
      });
      return { values } satisfies Extraction;
    },
    apply: (visible, changed) => {
      let s = store();
      if (!s.spaces[spaceId]) return false;
      const key = spaceListKey(s, spaceId);
      const pins = new Map<string, PinValue>();
      const groupValues = new Map<string, PinGroupValue>();
      for (const [k, v] of visible) {
        if (k.startsWith("pin:t:")) pins.set(k.slice(6), v as PinValue);
        else if (k.startsWith("pin:g:")) groupValues.set(k.slice(6), v as PinGroupValue);
      }
      const byPos =
        <T extends { pos: string }>(m: Map<string, T>) =>
        (a: string, z: string) =>
          m.get(a)!.pos < m.get(z)!.pos ? -1 : m.get(a)!.pos > m.get(z)!.pos ? 1 : a < z ? -1 : 1;
      const groupOrder = [...groupValues.keys()].sort(byPos(groupValues));
      const tileOrder = [...pins.keys()]
        .filter((id) => {
          const g = pins.get(id)!.g;
          return !g || !groupValues.has(g);
        })
        .sort(byPos(pins));
      const memberOrder = new Map(groupOrder.map((g) => [g, [...pins.keys()].filter((id) => pins.get(id)!.g === g).sort(byPos(pins))]));

      // A pin removed elsewhere goes; one whose page is open here stays, as a page.
      const goneTabs = [...changed]
        .filter((k) => k.startsWith("pin:t:") && !visible.has(k))
        .map((k) => k.slice(6))
        .filter((id) => s.tabs[id]);
      const open = (id: string) => !!s.tabs[id]!.navigation || !!s.tabs[id]!.adoptId;
      s = removeTabs(
        s,
        goneTabs.filter((id) => !open(id)),
        false,
      );
      const tabs = { ...s.tabs };
      for (const id of goneTabs)
        if (tabs[id]) {
          const { pinnedRow: _, folderId: _f, ...rest } = tabs[id]!;
          tabs[id] = { ...rest, pinned: false, pinnedUrl: null };
        }
      let groups = { ...s.groups };
      let pinnedFolders = { ...s.pinnedFolders };
      for (const k of changed)
        if (k.startsWith("pin:g:") && !visible.has(k)) {
          delete groups[k.slice(6)];
          delete pinnedFolders[k.slice(6)];
        }

      for (const id of groupOrder) {
        const v = groupValues.get(id)!;
        if (v.f) {
          const old = pinnedFolders[id];
          pinnedFolders[id] = {
            id,
            spaceId,
            name: v.n,
            icon: v.i,
            collapsed: old?.collapsed ?? false,
            createdAt: v.a ?? old?.createdAt ?? 0,
            ...(v.p ? { parentId: v.p } : {}),
            ...(v.b ? { beforeId: v.b } : {}),
          };
          delete groups[id];
          continue;
        }
        delete pinnedFolders[id];
        const old = groups[id];
        groups[id] = old
          ? { ...old, name: v.n, icon: v.i, color: v.c, pinned: true }
          : { id, spaceId, name: v.n, icon: v.i, color: v.c, collapsed: false, pinned: true, tabIds: [], createdAt: Date.now() };
      }
      pinnedFolders = normalizePinnedFolders(pinnedFolders);
      // Sync order includes empty folders too, so it also defines their sibling order.
      const folderOrder = [...Object.keys(pinnedFolders).filter((id) => !groupValues.has(id)), ...groupOrder.filter((id) => pinnedFolders[id])];
      pinnedFolders = Object.fromEntries(folderOrder.map((id) => [id, pinnedFolders[id]!]));
      const added: string[] = [];
      for (const [id, v] of pins) {
        const group = v.g && groups[v.g] ? groups[v.g]! : null;
        const folder = v.g && pinnedFolders[v.g] ? pinnedFolders[v.g]! : null;
        const row = !!folder || (!!v.r && !group);
        const old = tabs[id];
        if (old) {
          const { pinnedRow: _, folderId: _f, ...rest } = old;
          tabs[id] = {
            ...rest,
            pinned: !group && !row,
            ...(row ? { pinnedRow: true } : {}),
            ...(folder ? { folderId: folder.id } : {}),
            pinnedUrl: group ? null : v.u,
            customTitle: v.t,
            customIcon: v.i,
            ...(old.unloaded ? { url: v.u, title: v.ti } : {}),
          };
          continue;
        }
        // Not shown in a window yet: its page loads in the first that shows it.
        tabs[id] = {
          ...makeTab("", spaceId, v.u, { title: v.ti, pinned: !group && !row, ...(row ? { pinnedRow: true } : {}), customTitle: v.t, customIcon: v.i }),
          id,
          ...(folder ? { folderId: folder.id } : {}),
          pinnedUrl: group ? null : v.u,
          navigation: null,
          unloaded: true,
        };
        added.push(id);
      }
      const inGroup = new Set([...memberOrder.values()].flat().filter((id) => tabs[id]));
      for (const g of Object.values(groups)) {
        if (g.spaceId !== spaceId) continue;
        const wanted = g.pinned && memberOrder.has(g.id) ? memberOrder.get(g.id)!.filter((id) => tabs[id]) : g.tabIds.filter((id) => !inGroup.has(id));
        groups[g.id] = { ...g, tabIds: wanted };
      }
      for (const g of Object.values(groups)) if (g.spaceId === spaceId && !g.tabIds.length) delete groups[g.id];

      // The list in the synced order: its pins where its pins were, the rest as they are.
      const flatSequence = [...tileOrder, ...groupOrder.flatMap((g) => memberOrder.get(g) ?? [])];
      const rowSequence = flatSequence
        .filter((id) => tabs[id]?.pinnedRow)
        .sort((a, z) => {
          const aPos = pins.get(a)?.o ?? "";
          const zPos = pins.get(z)?.o ?? "";
          return aPos < zPos ? -1 : aPos > zPos ? 1 : 0;
        });
      const sequence = [
        ...flatSequence.filter((id) => tabs[id]?.pinned),
        ...rowSequence,
        ...flatSequence.filter((id) => !tabs[id]?.pinned && !tabs[id]?.pinnedRow),
      ];
      const rank = new Map(sequence.map((id, i) => [id, i]));
      const ids = [...listIds(s, key).filter((id) => tabs[id]), ...added];
      const slots = ids.map((id, i) => (rank.has(id) ? i : -1)).filter((i) => i >= 0);
      const sorted = slots.map((i) => ids[i]!).sort((a, z) => rank.get(a)! - rank.get(z)!);
      slots.forEach((slot, i) => (ids[slot] = sorted[i]!));
      const list = { key, tabIds: orderSections(pinnedFirst(ids, tabs), tabs, groups, pinnedFolders) };
      groups = syncGroupOrder(groups, list);
      const live = { ...s.live, ...Object.fromEntries(added.map((id) => [id, s.live[id] ?? IDLE_LIVE])) };
      useBrowser.setState(prunePinnedFolders(withList({ ...s, tabs, groups, live, pinnedFolders }, list)));
    },
  };
}

// MARK: Passwords

type PasswordValue = { o: string; u: string; p: string };

// Sync passwords through Chrome; disabling sync never deletes local passwords.
export function passwordsAdapter(
  spaceId: string,
  forced: () => boolean,
  readLogins: (engineProfile: string) => Promise<SavedLogin[] | null | undefined> = async (p) => SyncNative?.readPasswords(p),
): Adapter {
  let lastRead = 0;
  let quietUntil = 0;
  let created = new Map<string, number>();
  const profile = () => engineProfile(spaceId);
  const keyOf = (origin: string, username: string) => `pw:${origin}\n${username}`;
  const read = async () => {
    const logins = await readLogins(profile());
    if (!logins) return null;
    const out = new Map<string, PasswordValue & { c: number }>();
    for (const l of logins) {
      const origin = originOf(l);
      if (origin) out.set(keyOf(origin, l.username), { o: origin, u: l.username, p: l.password, c: l.created });
    }
    return out;
  };
  return {
    prefix: "pw:",
    extract: async () => {
      const now = Date.now();
      if (now < quietUntil || (now - lastRead < PASSWORD_READ_INTERVAL_MS && !forced())) return null;
      const logins = await read();
      if (!logins) return null;
      lastRead = now;
      created = new Map([...logins].map(([k, v]) => [k, v.c]));
      return { values: new Map([...logins].map(([k, { o, u, p }]) => [k, { o, u, p } satisfies PasswordValue])) };
    },
    editedAt: (v) => created.get(keyOf((v as PasswordValue).o, (v as PasswordValue).u)) || undefined,
    apply: async (visible, changed, base) => {
      const local = await read();
      if (!local) return false;
      let ok = true;
      for (const key of changed) {
        const v = visible.get(key) as PasswordValue | undefined;
        const have = local.get(key);
        const known = base(key) as PasswordValue | undefined;
        if (have && known?.p !== have.p) continue;
        const [origin, username] = [key.slice(3, key.indexOf("\n")), key.slice(key.indexOf("\n") + 1)];
        if (v) {
          if (have?.p === v.p) continue;
          if (have) ok = (await deletePassword(profile(), origin, username)) && ok;
          ok = (await savePassword(profile(), v.o, v.u, v.p)) && ok;
        } else if (have) {
          ok = (await deletePassword(profile(), origin, username)) && ok;
        }
      }
      // Wait for Chrome to write password changes before reading them.
      let settled = false;
      for (let i = 0; i < 20 && !settled; i++) {
        const now = await read();
        settled = !!now && [...changed].every((k) => (visible.get(k) as PasswordValue | undefined)?.p === now.get(k)?.p);
        if (!settled) await new Promise((r) => setTimeout(r, 250));
      }
      if (!settled) quietUntil = Date.now() + 30_000;
      return ok;
    },
  };
}

function originOf(login: SavedLogin): string | null {
  const realm = login.origin.replace(/\/$/, "");
  return /^https?:\/\/[^/\s]+$/.test(realm) ? realm : null;
}
