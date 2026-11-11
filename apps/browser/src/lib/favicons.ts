import { onHistoryChanged, removeLegacyFavicons } from "@bay/chromium";
import { readDocument, removeDocument, type IconTheme } from "@bay/desktop";
import { useEffect } from "react";
import { create, useStore } from "zustand";
import { batchStoreUpdates, useBrowser, type BrowserState } from "../store/browserStore";
import { engineProfile, isIncognitoSpace } from "../store/model";
import { DEFAULT_SPACE_ID } from "../store/constants";
import { appearanceStore } from "../store/derivedStores";
import { webviews } from "./webviews";
import { APPEARANCE_SWAP_MS, FAVICON_FLUSH_MS, MAX_FAVICONS } from "./constants";
import { askFavicons, askIcon, askTheme, forgetPage, forgetProfile } from "./enrichmentService";

// Favicons are Chrome's (FaviconService): Chrome saves a page's icon when the page shows it and drops it with the
// page's history. This is the app's in-memory cache of them, by page, plus what Chrome doesn't keep:
// - the icons tabs show right now, private windows' included (those stay here and in their own profile);
// - the light/dark pick: a page whose icon changes with the appearance keeps both, for this launch.
// Nothing here is saved.

type Icons = {
  // By page (no fragment): Chrome's answer, `null` when it has none.
  pages: Record<string, string | null>;
  // By icon URL: what tabs reported or the app fetched.
  srcs: Record<string, string>;
  // A page's [light, dark] icons.
  appearances: Record<string, [string, string]>;
};

const EMPTY: Icons = { pages: {}, srcs: {}, appearances: {} };
let appearanceChangedAt = -Infinity;

type Favicons = {
  // Keyed by cache key: the engine profile, or a private profile's own id.
  profiles: Record<string, Icons>;
  themes: Record<string, IconTheme | null>;
};

export const useFavicons = create<Favicons>(() => ({ profiles: {}, themes: {} }));

const cacheKey = (spaceId: string) => (isIncognitoSpace(spaceId) ? spaceId : engineProfile(spaceId));
export const pageKey = (url: string) => url.replace(/#.*$/, "");

// MARK: Writing

// Answers come in bursts (a launch asks Chrome about every tab's page, then checks each icon's shape), so changes
// wait for the next frame and land together, in order: one store update and one commit. A change that gives back
// what it got changes nothing, and no icon re-renders for it.
// Only maps made by this flush can be edited in place. Published maps are copied on their first write;
// counts follow those copies so a burst doesn't enumerate and spread a growing map for every icon.
// Keep ownership local to the flush: subscribers can synchronously queue and flush another batch.
class FaviconBatch {
  private sizes = new WeakMap<object, number>();

  size<Value>(map: Record<string, Value>): number {
    return this.sizes.get(map) ?? Object.keys(map).length;
  }

  set<T>(map: Record<string, T>, key: string, value: T, capped = false): Record<string, T> {
    let size = this.size(map);

    // At capacity even replacing an existing key starts over, just as a single queued write did.
    if (capped && size >= MAX_FAVICONS) {
      map = { [key]: value };
      size = 1;
    } else {
      if (!this.sizes.has(map)) map = { ...map };

      if (!Object.hasOwn(map, key)) size++;
      Object.defineProperty(map, key, { value, enumerable: true, configurable: true, writable: true });
    }

    this.sizes.set(map, size);

    return map;
  }
}

type Change = (f: Favicons, batch: FaviconBatch) => Favicons;

const changes: Change[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function queue(change: Change, now = false) {
  changes.push(change);

  if (now) flush();
  else flushTimer ??= setTimeout(flush, FAVICON_FLUSH_MS);
}

function flush() {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  const all = changes.splice(0);

  if (all.length) {
    batchStoreUpdates(() =>
      useFavicons.setState((f) => {
        const batch = new FaviconBatch();

        return all.reduce((s, change) => change(s, batch), f);
      }),
    );
  }
}

// `now` for what the user did (Clear Data, a closed private window) and for answers that come batched: applied after
// anything queued.
function update(key: string, change: (icons: Icons, batch: FaviconBatch) => Icons, now = false) {
  queue((f, batch) => {
    const before = f.profiles[key] ?? EMPTY;
    const after = change(before, batch);

    return after === before ? f : { ...f, profiles: batch.set(f.profiles, key, after) };
  }, now);
}

// The pages whose answer the queued changes may change, for the icons waiting on one (onFavicons); null: any page.
let watching = false;
let touched: Set<string> | null = new Set();
const touch = (page: string) => void (watching && touched?.add(page));
const touchAll = () => void (touched = null);

// MARK: Asking Chrome

// The pages that have been asked for, by profile. A page is asked again when its lookup failed, or when its
// history was deleted.
const asked = new Set<string>();

// The answers for a profile land in its cache. One sink per profile, so the answer of a lookup is one write.
const sinks = new Map<string, (icons: ReadonlyMap<string, string | null>) => void>();

const sinkFor = (profile: string) => {
  const existing = sinks.get(profile);

  if (existing) return existing;

  const sink = (answers: ReadonlyMap<string, string | null>) => {
    update(
      profile,
      (icons) => {
        let next: Record<string, string | null> | undefined;

        for (const [page, uri] of answers) {
          if (icons.pages[page] === uri) continue;
          next ??= { ...icons.pages };
          next[page] = uri;
          touch(page);
        }

        return next ? { ...icons, pages: next } : icons;
        // One answer is already a batch (up to LOOKUP_BATCH pages): it lands at once, not on another timer.
      },
      true,
    );
  };

  sinks.set(profile, sink);

  return sink;
};

function ask(key: string, page: string) {
  if (isIncognitoSpace(key) || asked.has(`${key}|${page}`)) return;
  asked.add(`${key}|${page}`);

  askFavicons({
    profile: key,
    page,
    onAnswers: sinkFor(key),
    // Asked again next time the page is shown.
    onFailed: () => void asked.delete(`${key}|${page}`),
  });
}

// MARK: Recording

/** A tab reports its page's icon: shown at once, and Chrome keeps it with the page. */
export function noteFavicon(tabId: string, src: string) {
  const tab = useBrowser.getState().tabs[tabId];

  if (!tab?.url || !src) return;
  const key = cacheKey(tab.spaceId);
  const page = pageKey(tab.url);
  const known = useFavicons.getState().profiles[key]?.srcs[src];

  if (known) return remember(key, page, src, known);

  if (!webviews.get(tabId)) return;

  // The tabs that report the same icon share one fetch.
  askIcon({
    profile: key,
    page,
    src,
    tabId,
    onIcon: (uri) => {
      if (uri) remember(key, page, src, uri);
    },
  });
}

function remember(key: string, page: string, src: string, uri: string) {
  // A page showing the icon it had (every load reports it again): nothing to queue, and no timer for it.
  const icons = changes.length ? undefined : useFavicons.getState().profiles[key];

  if (icons && icons.pages[page] === uri && icons.srcs[src] === uri) return;
  const dark = useBrowser.getState().ui.appDark;
  const swapped = Date.now() - appearanceChangedAt < APPEARANCE_SWAP_MS;
  update(key, (icons, batch) => {
    const previous = icons.pages[page];

    if (previous === uri && icons.srcs[src] === uri) return icons;
    let appearances = icons.appearances;

    if (swapped && previous && previous !== uri) appearances = batch.set(appearances, page, dark ? [previous, uri] : [uri, previous]);
    // A map that starts over forgets every other page.
    const startsOver = batch.size(icons.pages) >= MAX_FAVICONS;

    if (startsOver) touchAll();
    else touch(page);
    const pages = batch.set(icons.pages, page, uri, true);

    return { pages, srcs: icons.srcs[src] === uri ? icons.srcs : batch.set(icons.srcs, src, uri, true), appearances };
  });
}

const failedFetches = new Set<string>();

// An icon Chrome doesn't have for a page the app names with one (an imported bookmark never visited): fetched
// without cookies and handed to Chrome, which keeps it as an on-demand icon.
function fetchMissing(spaceId: string, url: string, src: string) {
  const key = cacheKey(spaceId);

  if (isIncognitoSpace(spaceId) || !/^https?:/i.test(src)) return;
  const id = `${key}|${src}`;

  if (failedFetches.has(id)) return;

  askIcon({
    profile: key,
    page: pageKey(url),
    src,
    tabId: null,
    onIcon: (uri) => {
      if (uri) remember(key, pageKey(url), src, uri);
      else failedFetches.add(id);
    },
  });
}

export function faviconFailed(spaceId: string, uri: string) {
  update(cacheKey(spaceId), (icons) => {
    if (!Object.values(icons.pages).includes(uri) && !Object.values(icons.srcs).includes(uri)) return icons;
    touchAll();

    return {
      pages: Object.fromEntries(Object.entries(icons.pages).map(([page, u]) => [page, u === uri ? null : u])),
      srcs: Object.fromEntries(Object.entries(icons.srcs).filter(([, u]) => u !== uri)),
      appearances: icons.appearances,
    };
  });
}

// MARK: Lookup

export type ResolvedFavicon = { uri: string; spaceId: string };

function lookupIn(key: string, url: string, src: string | null | undefined): string | undefined {
  const icons = useFavicons.getState().profiles[key];

  if (!icons) return undefined;
  const page = pageKey(url);
  const pair = icons.appearances[page];

  if (pair) return pair[useBrowser.getState().ui.appDark ? 1 : 0];

  return (src ? icons.srcs[src] : undefined) ?? icons.pages[page] ?? undefined;
}

// Where to look: the profile's own icons; a private window's (or no profile's) also the others'.
function lookupOrder(spaceId?: string): string[] {
  if (spaceId && !isIncognitoSpace(spaceId)) return [spaceId];

  return [...new Set([...(spaceId ? [spaceId] : []), DEFAULT_SPACE_ID, ...useBrowser.getState().spaceOrder])];
}

export function resolveFavicon(url: string, src?: string | null, spaceId?: string): ResolvedFavicon | null {
  if (!url) return null;

  for (const id of lookupOrder(spaceId)) {
    const uri = lookupIn(cacheKey(id), url, src);

    if (uri) return { uri, spaceId: id };
  }

  return null;
}

// Callers re-render on an appearance change themselves (useAppearanceDark): the lookup reads it for
// icons that have a light and a dark version.
export const useAppearanceDark = () => useStore(appearanceStore);

// Whether every profile the lookup reads has Chrome's answer for the page (an icon, or none).
function answered(url: string, spaceId?: string): boolean {
  const { profiles } = useFavicons.getState();
  const page = pageKey(url);

  return lookupOrder(spaceId).every((id) => isIncognitoSpace(id) || profiles[cacheKey(id)]?.pages[page] !== undefined);
}

// Icons with nothing to show yet, by page: one store subscriber for all of them (a long sidebar has hundreds), and only
// the ones whose page a change touched are looked at again.
type Watcher = { url: string; src?: string | null; spaceId?: string; known?: boolean };

const watchers = new Map<string, Set<Watcher>>();

function check(w: Watcher) {
  const known = answered(w.url, w.spaceId);

  if (known === w.known) return;
  w.known = known;

  if (!known) for (const id of lookupOrder(w.spaceId)) ask(cacheKey(id), pageKey(w.url));
  // This runs before React re-renders for an icon that just came: only "none" fetches.
  else if (w.src && w.spaceId && !resolveFavicon(w.url, w.src, w.spaceId)) fetchMissing(w.spaceId, w.url, w.src);
}

function onFavicons(f: Favicons, prev: Favicons) {
  const pages = touched;
  touched = new Set();

  if (f.profiles === prev.profiles) return;

  for (const page of pages ?? Array.from(watchers.keys())) for (const w of Array.from(watchers.get(page) ?? [])) check(w);
}

function watch(w: Watcher) {
  if (!watching) {
    watching = true;
    useFavicons.subscribe(onFavicons);
  }

  const page = pageKey(w.url);
  let set = watchers.get(page);

  if (!set) watchers.set(page, (set = new Set()));
  set.add(w);
  check(w);

  return () => {
    set.delete(w);

    if (!set.size && watchers.get(page) === set) watchers.delete(page);
  };
}

export function useFavicon(url: string, src?: string | null, spaceId?: string): ResolvedFavicon | null {
  const key = useFavicons(() => {
    const found = resolveFavicon(url, src, spaceId);

    return found ? `${found.spaceId} ${found.uri}` : null;
  });

  // No icon yet: ask Chrome, and when it has none, fetch the one the app names. Watched outside React: Chrome
  // answering "none" changes nothing on screen, so it doesn't re-render the icon.
  const missing = !!url && !key;
  // Without a profile the lookup reads every profile: one added since asks too, on the next render.
  const order = missing ? lookupOrder(spaceId).join(" ") : "";
  useEffect(() => (missing ? watch({ url, src, spaceId }) : undefined), [missing, order, spaceId, url, src]);
  const split = key?.indexOf(" ") ?? -1;

  return key ? { spaceId: key.slice(0, split), uri: key.slice(split + 1) } : null;
}

// MARK: Themes

export function useFaviconTheme(url: string, src?: string | null, spaceId?: string): IconTheme | null | undefined {
  const uri = useFavicons(() => resolveFavicon(url, src, spaceId)?.uri ?? null);
  const theme = useFavicons((f) => (uri ? f.themes[uri] : undefined));
  const pending = !!uri && theme === undefined;
  useEffect(() => {
    if (!pending || !uri) return;

    askTheme({
      uri,
      onTheme: (found) => queue((f, batch) => (f.themes[uri] === (found ?? null) ? f : { ...f, themes: batch.set(f.themes, uri, found ?? null, true) })),
    });
  }, [pending, uri]);

  return theme;
}

// MARK: Housekeeping

function forget(key: string) {
  for (const id of Array.from(asked)) if (id.startsWith(`${key}|`)) asked.delete(id);
  // The work that was on its way is not the profile's any more.
  forgetProfile(key);
  touchAll();
  update(key, () => EMPTY, true);
}

/** Clear Data deleted the profile's icons from Chrome: forget what's cached. */
export const pruneProfileFavicons = (spaceId: string) => forget(cacheKey(spaceId));

// Before Chrome kept them: an index per profile (favicons-<profile>.json) and a folder of PNGs per engine profile.
function removeLegacyFiles(s: Pick<BrowserState, "spaces">) {
  for (const id of Object.keys(s.spaces)) {
    const doc = `favicons-${id}.json`;

    try {
      if (readDocument(doc) === null) continue;
      removeDocument(doc);

      if (!isIncognitoSpace(id)) void removeLegacyFavicons(engineProfile(id)).catch(() => {});
    } catch (error) {
      console.warn(`[favicons] couldn't remove ${doc}`, error);
    }
  }
}

export function startFavicons() {
  removeLegacyFiles(useBrowser.getState());

  const history = onHistoryChanged((change) => {
    if (change.kind !== "deleted") return;

    if (change.all) return forget(change.profile);
    const gone = new Set(change.urls.map(pageKey));
    const key = change.profile;

    for (const page of gone) {
      asked.delete(`${key}|${page}`);
      // The answer that was on its way is not the page's any more.
      forgetPage(key, page);
    }

    update(key, (icons) => {
      if (!Object.keys(icons.pages).some((page) => gone.has(page))) return icons;

      for (const page of gone) touch(page);

      return { ...icons, pages: Object.fromEntries(Object.entries(icons.pages).filter(([page]) => !gone.has(page))) };
    });
  });

  const stop = useBrowser.subscribe((s, prev) => {
    if (s.ui.appDark !== prev.ui.appDark) appearanceChangedAt = Date.now();

    // Private profiles' icons go with their last window: nothing to look at while none are kept or queued.
    if (s.windows !== prev.windows && (changes.length || Object.keys(useFavicons.getState().profiles).some(isIncognitoSpace))) {
      const open = new Set(Object.values(s.windows).map((w) => w.spaceId));

      for (const t of Object.values(s.tabs)) open.add(t.spaceId);
      // After what's queued, which may still hold the window's icons.
      queue((f) => {
        const gone = Object.keys(f.profiles).filter((id) => isIncognitoSpace(id) && !open.has(id));

        if (gone.length) touchAll();

        return gone.length ? { ...f, profiles: Object.fromEntries(Object.entries(f.profiles).filter(([id]) => !gone.includes(id))) } : f;
      }, true);
    }
  });

  return () => {
    history.remove();
    stop();
  };
}
