import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EndpointError, requireControl } from "./endpoint.ts";
import { isRecord } from "./util.ts";

const CHROME_EPOCH_OFFSET = 11_644_473_600;
const SUBFRAME_TRANSITIONS = [3, 4];
const HISTORY_BUDGET_MS = 20_000;
const MAX_ROWS = 200_000;
const MAX_SESSION_BYTES = 256 * 1024 * 1024;
const DEFAULT_SPACE_ID = "default";
const PRIVATE_PREFIXES = ["incognito", "guest", "private", "System Profile", "Guest Profile"];
const NO_DATA_DIR = "{name}() needs Bay's data dir, and --port/--ws/$BAY_CDP_URL don't say where it is: pass --data-dir DIR or set $BAY_DATA_DIR";

export class BrowsingDataError extends Error {
  override name = "BrowsingDataError";
}

export class OutOfTime extends BrowsingDataError {
  override name = "OutOfTime";
}

type SpaceRow = { id: string; name?: string; profileId?: string };
export type PinnedTab = {
  title: string;
  url: string;
  pinnedUrl: string | null;
  kind: "favorite" | "pinned";
  folder: string | null;
  space: string;
  parked: boolean;
};

type TabRow = {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  pinnedUrl?: unknown;
  customTitle?: unknown;
  pinned?: unknown;
  pinnedRow?: unknown;
  folderId?: unknown;
  spaceId?: unknown;
};
type GroupRow = { id?: unknown; name?: unknown; spaceId?: unknown; pinned?: unknown; tabIds?: unknown };
type FolderRow = { id?: unknown; name?: unknown };
type SessionDoc = {
  version?: unknown;
  spaces?: Record<string, SpaceRow>;
  profiles?: Record<string, SpaceRow>;
  spaceOrder?: string[];
  profileOrder?: string[];
  tabs?: TabRow[];
  groups?: GroupRow[];
  pinnedFolders?: FolderRow[];
  tabLists?: Record<string, string[]>;
};

export type HistoryOptions = { days?: number; limit?: number | null; space?: string; domains?: boolean };
export type HistoryRow = { url: string; title: string; visits: number; total_visits: number; last_visit: string; space: string };
export type HistoryDomain = { domain: string; visits: number; pages: number; last_visit: string; top_title: string; space: string };

export function pinned(root: string | null): PinnedTab[] {
  const data = checkedRoot(root, "pinned");
  const session = readSession(data);
  const spaces = session.spaces ?? session.profiles ?? {};
  const order = session.spaceOrder ?? session.profileOrder ?? [];
  const names = new Map<string, string>();
  for (const [id, space] of Object.entries(spaces)) {
    if (isPrivateSpace(id)) continue;
    names.set(id, typeof space.name === "string" && space.name ? space.name : id);
  }
  const spaceOrder = [...new Set([...order.filter((id) => names.has(id)), ...names.keys()])];
  const tabs = new Map<string, TabRow>();
  for (const tab of session.tabs ?? []) if (typeof tab.id === "string") tabs.set(tab.id, tab);
  const folders = new Map<string, string>();
  for (const folder of session.pinnedFolders ?? []) {
    if (typeof folder.id === "string" && typeof folder.name === "string") folders.set(folder.id, folder.name);
  }
  const groups = (session.groups ?? []).filter((group) => group.pinned === true);
  const lists = session.tabLists ?? {};
  const rows: Array<{ order: number; row: PinnedTab }> = [];
  const seen = new Set<string>();
  let rank = 0;
  for (const spaceId of spaceOrder) {
    const ids = [...(lists[spaceId] ?? [])];
    for (const group of groups) {
      if (group.spaceId !== spaceId || !Array.isArray(group.tabIds)) continue;
      for (const id of group.tabIds) if (typeof id === "string" && !ids.includes(id)) ids.push(id);
    }
    for (const id of ids) {
      const tab = tabs.get(id);
      if (!tab || seen.has(id)) continue;
      const group = groups.find((item) => item.spaceId === spaceId && Array.isArray(item.tabIds) && item.tabIds.includes(id));
      const favorite = tab.pinned === true;
      const pinnedRow = tab.pinnedRow === true;
      if (!favorite && !pinnedRow && !group) continue;
      seen.add(id);
      const folderId = typeof tab.folderId === "string" ? tab.folderId : null;
      const title = firstString(tab.customTitle, tab.title, tab.url, tab.pinnedUrl);
      rows.push({
        order: rank++,
        row: {
          title,
          url: firstString(tab.url, tab.pinnedUrl),
          pinnedUrl: typeof tab.pinnedUrl === "string" ? tab.pinnedUrl : null,
          kind: favorite ? "favorite" : "pinned",
          folder: favorite ? null : group && typeof group.name === "string" ? group.name : folderId ? (folders.get(folderId) ?? null) : null,
          space: names.get(spaceId) ?? spaceId,
          parked: false,
        },
      });
    }
  }
  return rows.sort((a, b) => a.order - b.order).map((entry) => entry.row);
}

export function history(root: string | null, options: HistoryOptions = {}): Array<HistoryRow | HistoryDomain> {
  const started = Date.now();
  const deadline = started + HISTORY_BUDGET_MS;
  const data = checkedRoot(root, "history");
  const days = options.days ?? 1;
  const limit = options.limit === undefined ? 200 : options.limit;
  if (!(typeof days === "number") || !Number.isFinite(days) || days <= 0) throw new BrowsingDataError("days must be a positive number");
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) throw new BrowsingDataError("limit must be a positive integer or null");
  const session = readSession(data);
  const spots = spaceProfiles(session);
  const chosen = pickSpaces(spots, options.space);
  const cutoff = Math.round((Date.now() - days * 86_400_000 + CHROME_EPOCH_OFFSET * 1000) * 1000);
  const rows: HistoryRow[] = [];
  for (const spot of chosen) {
    outOfTime(deadline, "history()");
    const folder = join(data, "Chromium", spot.directory);
    const work = mkdtempSync(join(tmpdir(), "bay-history-"));
    let db: Database | undefined;
    try {
      const path = snapshot(join(folder, "History"), work, deadline);
      db = new Database(path, { readonly: true });
      const found = db
        .query<{ url: string; title: string | null; visits: number; last: number; total: number }, [number, number, number, number]>(
          `SELECT u.url AS url, u.title AS title, COUNT(v.id) AS visits, MAX(v.visit_time) AS last, u.visit_count AS total
         FROM visits v JOIN urls u ON u.id = v.url
         WHERE v.visit_time >= ? AND (v.transition & 255) NOT IN (?, ?) AND u.hidden = 0
           AND (u.url LIKE 'http://%' OR u.url LIKE 'https://%')
         GROUP BY u.id
         ORDER BY last DESC
         LIMIT ?`,
        )
        .all(cutoff, SUBFRAME_TRANSITIONS[0]!, SUBFRAME_TRANSITIONS[1]!, MAX_ROWS);
      for (const row of found) {
        rows.push({ url: row.url, title: row.title ?? "", visits: row.visits, total_visits: row.total, last_visit: String(row.last), space: spot.name });
      }
    } catch (error) {
      if (error instanceof BrowsingDataError) throw error;
      throw new BrowsingDataError(`can't read ${spot.name}'s history (${messageOf(error)})`);
    } finally {
      db?.close();
      rmSync(work, { recursive: true, force: true });
    }
  }
  rows.sort((a, b) => Number(b.last_visit) - Number(a.last_visit));
  let result: Array<HistoryRow | HistoryDomain>;
  if (options.domains) {
    const rolled = new Map<string, HistoryDomain>();
    for (const row of rows) {
      const host = hostOf(row.url).replace(/^www\./, "");
      const key = `${row.space}\u0000${host}`;
      const entry = rolled.get(key) ?? { domain: host, visits: 0, pages: 0, last_visit: row.last_visit, top_title: row.title, space: row.space };
      entry.visits += row.visits;
      entry.pages += 1;
      rolled.set(key, entry);
    }
    result = [...rolled.values()].sort((a, b) => b.visits - a.visits || Number(b.last_visit) - Number(a.last_visit));
  } else {
    result = rows;
  }
  if (limit !== null) result = result.slice(0, limit);
  return result.map((entry) => ({ ...entry, last_visit: iso(Number(entry.last_visit)) }));
}

function checkedRoot(root: string | null, name: string): string {
  if (!root) throw new BrowsingDataError(NO_DATA_DIR.replace("{name}", name));
  try {
    requireControl(root);
  } catch (error) {
    if (error instanceof EndpointError) throw new BrowsingDataError(error.message);
    throw error;
  }
  return root;
}

function readSession(root: string): SessionDoc {
  const path = join(root, "session.json");
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    return {};
  }
  if (!stats.isFile()) throw new BrowsingDataError(`${path} isn't a regular file`);
  if (stats.size > MAX_SESSION_BYTES) throw new BrowsingDataError(`${path} is too big`);
  let session: unknown;
  try {
    session = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new BrowsingDataError(`${path} isn't valid JSON (Bay may be writing it; try again)`);
  }
  return isRecord(session) && session.version === 2 ? (session as SessionDoc) : {};
}

function isPrivateSpace(id: string): boolean {
  return id.startsWith("incognito:");
}

type SpaceProfile = { id: string; name: string; directory: string };

/** Which native profile each space uses ("Default", "Profile <id>"), one label per folder. */
function spaceProfiles(session: SessionDoc): SpaceProfile[] {
  const spaces = session.spaces ?? session.profiles ?? {};
  const order = session.spaceOrder ?? session.profileOrder ?? [];
  const publicSpaces = Object.entries(spaces).filter(([id]) => !isPrivateSpace(id));
  const byId = new Map(publicSpaces);
  const ordered = [...order.filter((id) => byId.has(id)), ...publicSpaces.map(([id]) => id).filter((id) => !order.includes(id))];
  const spots: SpaceProfile[] = [];
  const seen = new Set<string>();
  for (const id of ordered) {
    const space = byId.get(id)!;
    const profileId = typeof space.profileId === "string" && space.profileId ? space.profileId : id;
    const engine = profileId === DEFAULT_SPACE_ID ? "" : profileId;
    const directory = engine ? `Profile ${engine}` : "Default";
    if (seen.has(directory)) continue;
    seen.add(directory);
    const owner = byId.get(profileId);
    const name = owner && typeof owner.name === "string" && owner.name ? owner.name : typeof space.name === "string" && space.name ? space.name : id;
    spots.push({ id, name, directory });
  }
  return spots;
}

function pickSpaces(spots: SpaceProfile[], wanted: string | undefined): SpaceProfile[] {
  if (!wanted) return spots;
  const chosen = spots.filter((spot) => spot.name === wanted || spot.id === wanted || spot.directory === wanted);
  if (!chosen.length) {
    const known = spots.map((spot) => spot.name).join(", ") || "none";
    throw new BrowsingDataError(`no space named ${JSON.stringify(wanted)} has history (known: ${known})`);
  }
  return chosen;
}

function snapshot(history: string, work: string, deadline: number): string {
  const target = join(work, "History");
  try {
    const info = lstatSync(history);
    if (!info.isFile()) throw new Error("isn't a regular file");
    outOfTime(deadline, "history()");
    copyFileSync(history, target);
    for (const suffix of ["-wal", "-journal"]) {
      const side = `${history}${suffix}`;
      if (existsSync(side) && !lstatSync(side).isSymbolicLink() && statSync(side).isFile()) copyFileSync(side, `${target}${suffix}`);
    }
    check(target);
    return target;
  } catch (error) {
    if (error instanceof BrowsingDataError) throw error;
    // Bay may hold the database; a read-only handle on it still answers most of the time.
    outOfTime(deadline, "history()");
    check(history);
    return history;
  }
}

function check(path: string): void {
  const db = new Database(path, { readonly: true });
  try {
    db.query("SELECT count(*) FROM urls").get();
    db.query("SELECT count(*) FROM visits").get();
  } finally {
    db.close();
  }
}

function outOfTime(deadline: number, what: string): void {
  if (Date.now() > deadline) throw new OutOfTime(`${what} ran out of time`);
}

function iso(chromeMicroseconds: number): string {
  const date = new Date(chromeMicroseconds / 1000 - CHROME_EPOCH_OFFSET * 1000);
  return localIso(date);
}

function localIso(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function firstString(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string" && value) return value;
  return "";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Kept for the space picker's sanity: a Chromium profile folder is one of these, never a link to somewhere else.
export function profileFolders(root: string): string[] {
  try {
    return readdirSync(join(root, "Chromium")).filter((name) => {
      if (name !== "Default" && !name.startsWith("Profile ")) return false;
      const suffix = name.startsWith("Profile ") ? name.slice(8) : "";
      if (PRIVATE_PREFIXES.some((prefix) => suffix.toLowerCase().startsWith(prefix.toLowerCase()))) return false;
      if (suffix.includes("@") || suffix.includes(":")) return false;
      const folder = join(root, "Chromium", name, "History");
      try {
        return lstatSync(folder).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
