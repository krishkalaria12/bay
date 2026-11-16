// What the phone syncs, as records the computer's sync writes and reads (apps/browser/src/sync/adapters.ts): this
// device's name, its open tabs, the bookmarks and the history. The record shapes are the computer's, field for field,
// so either side reads what the other wrote. Pure: the store comes in as functions, so Node's tests run these.
import type { JsonValue } from "@bay/sync/src/canon.ts";
import { assignPositions } from "@bay/sync/src/order.ts";
import type { Adapter } from "@bay/sync/src/scope.ts";
import * as v from "valibot";

import { BOOKMARK_LIMIT, BOOKMARKS_ROOT } from "../store/bookmarks.ts";
import type { Bookmarks, BrowserTab, HistoryEntry } from "../store/types.ts";

/** How far back history syncs: the computer's HISTORY_WINDOW_MS. */
export const HISTORY_WINDOW_MS = 90 * 86_400_000;

/** A visit read back within this is the same visit (the computer's SAME_VISIT_MS). */
const SAME_VISIT_MS = 1;

/** The visits a history record keeps. */
const MAX_VISIT_TIMES = 20;

/** The open tabs a device lists for the others (the computer's MAX_DEVICE_TABS). */
export const MAX_DEVICE_TABS = 30;

/** The folder the computer's bookmarks bar is on the phone, which has one tree. */
export const SYNC_BAR = "bay-sync-bar";

export type DeviceRecord = { n: string };

export type DeviceTabs = { n: string; tabs: { u: string; t: string }[] };

type BookmarkValue = { k: "u" | "f"; p: string; t: string; u?: string; a: number; pos: string };

type HistoryValue = { t: string; n: number; vt: number[] };

export const DeviceRecordSchema = v.object({ n: v.string() });

export const DeviceTabsSchema = v.object({ n: v.string(), tabs: v.array(v.object({ u: v.string(), t: v.string() })) });

const BookmarkSchema = v.object({
  k: v.picklist(["u", "f"]),
  p: v.string(),
  t: v.string(),
  u: v.optional(v.string()),
  a: v.number(),
  pos: v.string(),
});

const HistorySchema = v.object({ t: v.string(), n: v.number(), vt: v.array(v.number()) });

/** A record's value as `schema` reads it, or undefined when it's something else (a newer device's shape, say). */
function read<S extends v.GenericSchema>(schema: S, value: JsonValue | undefined): v.InferOutput<S> | undefined {
  const parsed = v.safeParse(schema, value);

  return parsed.success ? parsed.output : undefined;
}

/** What syncs to the computer's history: its own rule (keptInHistory), web and file pages. */
const keptInHistory = (url: string) => /^(https?|file):/i.test(url);

/** This device's name, under `dev:` in the app's scope, where the computer lists the account's devices. */
export function deviceAdapter(deviceId: string, name: () => string): Adapter {
  const key = `dev:${deviceId}`;

  return {
    prefix: "dev:",
    extract: () => ({ values: new Map([[key, { n: name() } satisfies DeviceRecord]]), ignore: (other) => other !== key }),
    apply: () => true,
  };
}

/** The phone's open tabs, newest first, for the other devices to open; theirs are read from the scope (engine.ts). */
export function deviceTabsAdapter(deviceId: string, name: () => string, tabs: () => readonly BrowserTab[]): Adapter {
  const key = `tabs:${deviceId}`;

  return {
    prefix: "tabs:",
    extract: () => {
      const open = tabs()
        .filter((tab) => !tab.private && /^https?:/i.test(tab.url))
        .sort((a, b) => b.lastVisit - a.lastVisit)
        .slice(0, MAX_DEVICE_TABS)
        .map((tab) => ({ u: tab.url, t: tab.title }));

      return { values: new Map([[key, { n: name(), tabs: open } satisfies DeviceTabs]]), ignore: (other) => other !== key };
    },
    apply: () => true,
  };
}

/**
 * Bookmarks. The computer has two trees, the bar and the other bookmarks; the phone one. The phone's tree is the
 * computer's other bookmarks, and the computer's bar is a folder at its top (`SYNC_BAR`). A bookmark's record key is
 * its id: the computer's UUID, or a phone's own id, which the computer maps to a UUID of its own (bookmarkUuidFor).
 */
export function bookmarksAdapter({
  ready,
  bookmarks,
  replace,
  barTitle,
}: {
  ready: () => boolean;
  bookmarks: () => Bookmarks;
  replace: (bookmarks: Bookmarks) => void;
  barTitle: () => string;
}): Adapter {
  const keyOf = (id: string) => (id === BOOKMARKS_ROOT ? "other" : id === SYNC_BAR ? "bar" : id);

  return {
    prefix: "bm:",
    extract: (base) => {
      if (!ready()) return null;

      const tree = bookmarks();
      const values = new Map<string, JsonValue>();
      const seen = new Set<string>();

      const walk = (folderId: string) => {
        const folder = tree[folderId];

        if (folder?.kind !== "folder" || seen.has(folderId)) return;

        seen.add(folderId);

        const parent = keyOf(folderId);
        const children = folder.children.filter((id) => tree[id] && !(folderId === BOOKMARKS_ROOT && id === SYNC_BAR));

        const positions = assignPositions(
          children.map((id) => {
            const known = read(BookmarkSchema, base(`bm:${id}`));

            return known?.p === parent ? known.pos : undefined;
          }),
        );

        children.forEach((id, i) => {
          const node = tree[id]!;
          const value: BookmarkValue = { k: node.kind === "url" ? "u" : "f", p: parent, t: node.title, a: node.addedAt, pos: positions[i]! };

          if (node.kind === "url") value.u = node.url;

          values.set(`bm:${id}`, value);

          if (node.kind === "folder") walk(id);
        });
      };

      walk(BOOKMARKS_ROOT);
      walk(SYNC_BAR);

      return { values };
    },
    apply: (visible) => {
      if (!ready()) return false;

      const records = new Map<string, BookmarkValue>();

      for (const [key, value] of visible) {
        const record = read(BookmarkSchema, value);

        if (record) records.set(key.slice(3), record);
      }

      replace(bookmarkTree(records, barTitle()));
    },
  };
}

/** The phone's tree from the bookmark records: orphans and loops go to the top, siblings in their order. */
export function bookmarkTree(records: ReadonlyMap<string, BookmarkValue>, barTitle: string): Bookmarks {
  const rootOf = (key: string) => (key === "other" ? BOOKMARKS_ROOT : key === "bar" ? SYNC_BAR : null);
  const parentOf = new Map<string, string>();

  for (const [id, record] of records) {
    const root = rootOf(record.p);

    parentOf.set(id, root ?? (records.get(record.p)?.k === "f" ? record.p : BOOKMARKS_ROOT));
  }

  // A folder inside itself, however far down: it moves to the top.
  for (const id of [...records.keys()].sort()) {
    const seen = new Set([id]);

    for (let at = parentOf.get(id)!; parentOf.has(at); at = parentOf.get(at)!) {
      if (seen.has(at)) {
        parentOf.set(id, BOOKMARKS_ROOT);
        break;
      }

      seen.add(at);
    }
  }

  const children = new Map<string, string[]>([
    [BOOKMARKS_ROOT, []],
    [SYNC_BAR, []],
  ]);

  for (const id of [...records.keys()].sort()) {
    const parent = parentOf.get(id)!;

    children.set(parent, [...(children.get(parent) ?? []), id]);
  }

  const order = (a: string, b: string) => {
    const pa = records.get(a)!.pos;
    const pb = records.get(b)!.pos;

    return pa < pb ? -1 : pa > pb ? 1 : a < b ? -1 : 1;
  };

  const tree: Bookmarks = {};
  let count = 0;

  for (const [id, record] of records) {
    if (++count > BOOKMARK_LIMIT) break;

    const parentId = parentOf.get(id)!;

    tree[id] =
      record.k === "u"
        ? { kind: "url", id, parentId, title: record.t, url: record.u ?? "", addedAt: record.a }
        : { kind: "folder", id, parentId, title: record.t, children: [], addedAt: record.a };
  }

  const bar = (children.get(SYNC_BAR) ?? []).filter((id) => tree[id]);
  const top = (children.get(BOOKMARKS_ROOT) ?? []).filter((id) => tree[id]).sort(order);

  tree[BOOKMARKS_ROOT] = { kind: "folder", id: BOOKMARKS_ROOT, parentId: null, title: "", children: bar.length ? [SYNC_BAR, ...top] : top, addedAt: 0 };

  if (bar.length) tree[SYNC_BAR] = { kind: "folder", id: SYNC_BAR, parentId: BOOKMARKS_ROOT, title: barTitle, children: bar.sort(order), addedAt: 0 };

  for (const [parent, ids] of children) {
    const folder = tree[parent];

    if (parent !== BOOKMARKS_ROOT && parent !== SYNC_BAR && folder?.kind === "folder") {
      tree[parent] = { ...folder, children: ids.filter((id) => tree[id]).sort(order) };
    }
  }

  return tree;
}

/** History's changes for the store: pages to put in or update, pages to take out. */
export interface HistoryChange {
  entries: HistoryEntry[];
  removed: string[];
}

/**
 * History, as the computer syncs it: a record per page with its title, visit count and visit times. The phone keeps
 * its newest pages only (HISTORY_LIMIT), so a record at or below its oldest is out of its reach, not deleted.
 */
export function historyAdapter({
  ready,
  history,
  limit,
  apply,
  now = Date.now,
}: {
  ready: () => boolean;
  history: () => readonly HistoryEntry[];
  limit: number;
  apply: (change: HistoryChange) => void;
  now?: () => number;
}): Adapter {
  const lastVisitOf = (value: HistoryValue) => Math.max(0, ...value.vt);

  return {
    prefix: "h:",
    extract: (base) => {
      if (!ready()) return null;

      const since = now() - HISTORY_WINDOW_MS;
      const entries = history();
      const values = new Map<string, JsonValue>();
      const floor = entries.length >= limit ? Math.min(...entries.map((entry) => entry.lastVisit)) : -Infinity;

      for (const entry of entries) {
        if (!keptInHistory(entry.url) || entry.lastVisit < since) continue;

        const key = `h:${entry.url}`;
        const known = read(HistorySchema, base(key));
        const visited = !known || !known.vt.some((time) => Math.abs(time - entry.lastVisit) <= SAME_VISIT_MS);

        if (!visited && known) {
          values.set(key, known);
          continue;
        }

        const times = [...new Set([...(known?.vt ?? []), entry.lastVisit])].sort((a, b) => a - b).slice(-MAX_VISIT_TIMES);

        values.set(key, { t: entry.title || known?.t || "", n: Math.max(entry.visits, known?.n ?? 0), vt: times } satisfies HistoryValue);
      }

      const ignore = (key: string) => {
        if (!keptInHistory(key.slice(2))) return true;

        const known = read(HistorySchema, base(key));

        // Gone by age everywhere, or below what the phone keeps: not a deletion.
        return !!known && (lastVisitOf(known) < since || lastVisitOf(known) <= floor);
      };

      return { values, ignore };
    },
    editedAt: (value) => {
      const record = read(HistorySchema, value);

      return record ? lastVisitOf(record) : undefined;
    },
    apply: (visible, changed) => {
      if (!ready()) return false;

      const since = now() - HISTORY_WINDOW_MS;
      const byUrl = new Map(history().map((entry) => [entry.url, entry]));
      const change: HistoryChange = { entries: [], removed: [] };

      for (const key of changed) {
        const url = key.slice(2);

        if (!keptInHistory(url)) continue;

        const record = read(HistorySchema, visible.get(key));
        const old = byUrl.get(url);

        if (record) {
          const lastVisit = lastVisitOf(record);

          if (lastVisit < since || !lastVisit) continue;

          change.entries.push({
            url,
            title: record.t || old?.title || "",
            favicon: old?.favicon ?? null,
            visits: Math.max(record.n, old?.visits ?? 0, 1),
            lastVisit: Math.max(lastVisit, old?.lastVisit ?? 0),
          });
        } else if (old) {
          change.removed.push(url);
        }
      }

      if (change.entries.length || change.removed.length) apply(change);
    },
  };
}
