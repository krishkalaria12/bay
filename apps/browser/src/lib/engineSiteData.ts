import { applySiteCookies, canCarrySiteCookies, getSiteSettings, siteCookies, type CookieName, type PageEngine, type SiteCookie } from "@bay/chromium";
import * as v from "valibot";
import { switchedOff } from "./killSwitches";

// Bringing sign-ins along (Settings › Engines): a page switching engines takes its site's cookies and storage from the
// engine it leaves to the one it opens in, so the switch doesn't sign the person out. Each engine keeps its own store;
// this copies between them in memory, for the tab's space profile and the site's registrable domain, never for a
// private window or a site whose cookies are blocked.

/** A stored cookie's identity: two with the same name, domain and path are the same cookie. */
export const cookieKey = (c: CookieName) => `${c.name}|${c.domain.toLowerCase()}|${c.path}`;

export type CarryPlan = { set: SiteCookie[]; remove: CookieName[]; known: Set<string> };

const same = (a: SiteCookie, b: SiteCookie) =>
  a.value === b.value && (a.expires ?? 0) === (b.expires ?? 0) && a.secure === b.secure && a.httpOnly === b.httpOnly && a.sameSite === b.sameSite;

/** What a carry from `source` (the engine the page leaves) writes to `target`. The leaving engine's cookies win, since
 *  the page was just used there. `known` is the ledger: the cookies both engines had after the site's last carry. One
 *  of those the source no longer has was removed there (a sign-out), so it goes from the target too. A cookie only the
 *  target ever had is its own, and stays. */
export function planCarry(source: readonly SiteCookie[], target: readonly SiteCookie[], known: ReadonlySet<string>): CarryPlan {
  const sourceKeys = new Set(source.map(cookieKey));
  const targetByKey = new Map(target.map((c) => [cookieKey(c), c]));

  const set = source.filter((c) => {
    const there = targetByKey.get(cookieKey(c));

    return !there || !same(there, c);
  });

  const remove = target.flatMap(({ name, domain, path }) => {
    const key = cookieKey({ name, domain, path });

    return known.has(key) && !sourceKeys.has(key) ? [{ name, domain, path }] : [];
  });

  return { set, remove, known: sourceKeys };
}

// The ledger, per profile and site, for the app's run: after a relaunch the first carry removes nothing.
const ledger = new Map<string, Set<string>>();
const carrying = new Map<string, Promise<boolean>>();

const MAX_CARRIED = 1000;

/** Carries a site's cookies from one engine's store to the other's for a profile. Resolves whether it did; a carry
 *  already running for the same site and direction is shared. */
export function carrySignIns(from: PageEngine, to: PageEngine, profile: string, site: string, origin: string): Promise<boolean> {
  const key = `${profile}|${site}|${from}`;
  const running = carrying.get(key);

  if (running) return running;

  const carry = (async () => {
    if (from === to || profile.startsWith("incognito") || !canCarrySiteCookies() || switchedOff("signInCarry")) return false;
    const settings = await getSiteSettings(profile, origin).catch(() => null);

    if (settings?.cookies?.value === "block") return false;
    const [source, target] = await Promise.all([siteCookies(from, profile, site), siteCookies(to, profile, site)]);

    if (!source || !target) return false;
    const plan = planCarry(source.slice(0, MAX_CARRIED), target, ledger.get(`${profile}|${site}`) ?? new Set());

    if (plan.set.length || plan.remove.length) {
      const applied = await applySiteCookies(to, profile, plan.set, plan.remove.slice(0, MAX_CARRIED - plan.set.length));

      if (!applied) return false;
    }

    ledger.set(`${profile}|${site}`, plan.known);

    return true;
  })().finally(() => carrying.delete(key));

  carrying.set(key, carry);

  return carry;
}

// MARK: Storage

// localStorage has no store-to-store copy in either engine: it's read by script from the page as it leaves and written
// into the new page once that has committed (lib/pageEngines.ts engineViewLoaded).

const StorageSchema = v.array(v.tuple([v.string(), v.string()]));
const MAX_STORAGE_CHARS = 2 * 1024 * 1024;

export type CarriedStorage = { origin: string; entries: [string, string][] };

/** The script that reads a page's localStorage, as JSON entries (null when it's too large to carry or unreadable). */
export const READ_STORAGE = `(() => { try { const s = JSON.stringify(Object.entries(localStorage)); return s.length > ${MAX_STORAGE_CHARS} ? null : s; } catch { return null; } })()`;

/** The entries a page's READ_STORAGE reply holds, or null. */
export function storageFrom(reply: string | null | undefined): [string, string][] | null {
  if (!reply) return null;

  try {
    const parsed = v.safeParse(StorageSchema, JSON.parse(reply));

    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

/** The script that writes carried entries into the new page's localStorage, leaving its other keys alone. */
export const writeStorageScript = (entries: [string, string][]) =>
  `(() => { try { for (const [k, v] of ${JSON.stringify(entries)}) if (localStorage.getItem(k) !== v) localStorage.setItem(k, v); } catch {} })()`;
