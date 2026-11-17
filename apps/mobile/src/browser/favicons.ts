// Site icons come from the site itself (no third-party icon service learns what you browse): the icon the open page
// names, or for a site Bay already knows (a tab, a pin, a bookmark, history) that has none yet, its apple-touch-icon or
// /favicon.ico, fetched in the background two at a time. Each is downloaded without cookies, checked to be an image,
// kept in the app's documents (the system may empty a cache) and drawn from that copy, so showing it makes no request.
// An icon too small to stay sharp on a large tile (a 16 px favicon.ico) is kept only until the site gives a bigger one:
// its apple-touch-icon is asked for when the page names nothing bigger, and once a launch for icons saved before. One
// job per site runs at a time, and clearing history or browsing data deletes the files of the icons it drops. Icons are
// best effort: a failure is dropped, and the next visit or launch tries again.
import type { Tab } from "@bay/engine";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as v from "valibot";
import type { Operation } from "../effect/errors.ts";
import { BrowserState } from "../effect/ports/browserState.ts";
import { Diagnostics } from "../effect/ports/diagnostics.ts";
import { Engine } from "../effect/ports/engine.ts";
import { Files } from "../effect/ports/files.ts";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { FAVICON_SCRIPT } from "../pagescripts/favicon.ts";
import { bookmarkLinks } from "../store/bookmarks.ts";
import { siteHost } from "../store/model.ts";
import type { BrowserData } from "../store/types.ts";

/** Where the icons are kept, in the app's documents. Earlier versions kept them in the cache. */
const ROOT = "document";
const OLD_ROOT = "cache";
const FOLDER = "favicons";

/** Icons fetched for known sites at once, so a long imported history doesn't flood the network. */
const AT_ONCE = 2;

/** The known sites asked for an icon each launch, most recently used first. */
const KNOWN_LIMIT = 200;

/** Where a site usually keeps its 180 px icon for home screens. */
const TOUCH_ICON = "/apple-touch-icon.png";

/** The paths a site's own icon usually sits at, best first, for a site with no page open. */
const KNOWN_ICON_PATHS = [TOUCH_ICON, "/favicon.ico"];

/** Sent until a page has told Bay the engine's own user agent; some sites refuse requests from unknown clients. */
const FALLBACK_USER_AGENT = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";

/** Smaller than this isn't an image. */
const MIN_BYTES = 16;

/** Larger than this isn't an icon. A 180 px touch icon with a photo in it can pass 64 KB. */
const MAX_BYTES = 256 * 1024;

/**
 * Wide enough, in pixels, to stay sharp on the tiles icons mostly sit on. The largest tiles want 180 px at 3x; an icon
 * narrower than this is replaced when the site has a wider one.
 */
export const SHARP_WIDTH = 96;

/** The bytes read to learn an icon's width: an ICO's header and sixteen of its pictures. */
const HEAD_BYTES = 6 + 16 * 16;

/** The icon the page links to, and the user agent to ask for it with. The page can answer with anything. */
const faviconSourceSchema = v.nullable(v.object({ href: v.string(), userAgent: v.string() }));

/** An icon's file, named after its site. */
const iconPath = (host: string) => `${FOLDER}/${encodeURIComponent(host)}`;

/** Where an icon downloads to before it is checked; it replaces the site's file only if it is wider. */
const partPath = (host: string) => `${iconPath(host)}.part`;

/** Whether a file's first bytes are an image React Native can draw: PNG, ICO, JPEG, GIF, WebP or BMP. */
export function isImage(head: string): boolean {
  return (
    head.startsWith("\x89PNG") ||
    head.startsWith("\0\0\x01\0") ||
    head.startsWith("\xFF\xD8") ||
    head.startsWith("GIF8") ||
    (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") ||
    head.startsWith("BM")
  );
}

/**
 * An icon's width in pixels from its first bytes: a PNG's, a GIF's, or an ICO's widest picture. Null for a format whose
 * width sits further in (JPEG, WebP), which are photos large enough to be sharp.
 */
export function iconWidth(head: string): number | null {
  const byte = (at: number) => head.charCodeAt(at) || 0;

  if (head.startsWith("\x89PNG")) return byte(16) * 2 ** 24 + byte(17) * 2 ** 16 + byte(18) * 2 ** 8 + byte(19);

  if (head.startsWith("GIF8")) return byte(6) + byte(7) * 2 ** 8;

  if (!head.startsWith("\0\0\x01\0")) return null;

  const count = byte(4) + byte(5) * 2 ** 8;
  let widest = 0;

  // Each picture's entry is 16 bytes after the 6-byte header; a width of 0 means 256.
  for (let index = 0; index < count && 6 + index * 16 < head.length; index++) widest = Math.max(widest, byte(6 + index * 16) || 256);

  return widest;
}

/**
 * The sites Bay already shows, without an icon yet: tabs and pins first, then bookmarks, then history by last visit.
 * Private tabs never ask: a site's icon would say what was opened privately.
 */
export function knownSitesWithoutIcons(data: BrowserData, limit = KNOWN_LIMIT): string[] {
  const history = [...data.history].sort((a, b) => b.lastVisit - a.lastVisit);

  const urls = [
    ...data.tabs.filter((tab) => !tab.private).map((tab) => tab.url),
    ...data.pinnedSites.map((pin) => pin.url),
    ...data.archive.map((item) => item.url),
    ...bookmarkLinks(data.bookmarks).map((link) => link.url),
    ...history.map((entry) => entry.url),
  ];

  const hosts = new Set<string>();

  for (const url of urls) {
    const host = /^https?:/i.test(url) ? siteHost(url) : "";

    if (host && !data.favicons[host]) hosts.add(host);

    if (hosts.size >= limit) break;
  }

  return [...hosts];
}

export class Favicons extends Context.Service<
  Favicons,
  {
    /** Saves the open page's icon if its site has none yet. */
    readonly fetch: (view: Tab, url: string) => Effect.Effect<void>;
    /** Deletes the files of icons the store drops. It runs on the app scope. */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("bay/Favicons") {
  static readonly layer = Layer.effect(
    Favicons,
    Effect.gen(function* () {
      const engine = yield* Engine;
      const files = yield* Files;
      const browserState = yield* BrowserState;
      const diagnostics = yield* Diagnostics;
      // The job each site's icon is in. A site that already has one isn't asked again until it ends.
      const jobs = yield* FiberMap.make<string>();
      // Known sites asked this launch, so a site with no icon at either path isn't asked again until the next one.
      const asked = new Set<string>();
      // Sites whose small icon an open page was asked to replace this launch.
      const pageAsked = new Set<string>();
      const atOnce = yield* Semaphore.make(AT_ONCE);
      // The engine's user agent, from the last page that named its icon.
      const userAgent = yield* Ref.make(FALLBACK_USER_AGENT);

      /** Drops the failures an icon is expected to have, and reports a defect. */
      const bestEffort = <E, R>(operation: Operation, effect: Effect.Effect<void, E, R>): Effect.Effect<void, never, R> =>
        effect.pipe(
          Effect.catch(() => Effect.void),
          Effect.catchDefect((defect) => {
            const error = defect instanceof Error ? defect : new Error(String(defect));

            return diagnostics.report({ operation, message: error.message, cause: error });
          }),
        );

      // Saved icons' widths, read from their files when first needed.
      const widths = new Map<string, number>();

      /** The width of the icon a site has now: 0 for none, a JPEG's or WebP's counted as sharp. */
      const widthOf = (host: string) =>
        Effect.gen(function* () {
          const known = widths.get(host);

          if (known !== undefined) return known;

          if (!(yield* browserState.data()).favicons[host] || !(yield* files.exists(ROOT, iconPath(host)))) return 0;

          const width = iconWidth(yield* files.head(ROOT, iconPath(host), HEAD_BYTES)) ?? SHARP_WIDTH;

          widths.set(host, width);

          return width;
        }).pipe(Effect.catch(() => Effect.succeed(0)));

      /**
       * Downloads an icon and keeps it if it is an image of an icon's size, wider than the one the site has. Whether it
       * was kept.
       */
      const save = (host: string, href: string, agent: string) =>
        Effect.gen(function* () {
          const part = partPath(host);
          const had = yield* widthOf(host);

          yield* files.createDirectory(ROOT, FOLDER);
          yield* files.download(ROOT, part, href, { "User-Agent": agent, Accept: "image/*" });

          const size = yield* files.size(ROOT, part);
          const head = size < MIN_BYTES || size > MAX_BYTES ? "" : yield* files.head(ROOT, part, HEAD_BYTES);
          const width = isImage(head) ? (iconWidth(head) ?? SHARP_WIDTH) : 0;

          if (width <= had) {
            yield* files.delete(ROOT, part);

            return false;
          }

          yield* files.move(ROOT, part, iconPath(host));
          widths.set(host, width);

          // A wider icon takes the narrower one's file, so its address changes too: an image already drawn is cached by it.
          const uri = yield* files.uri(ROOT, iconPath(host));

          yield* browserState.dispatch({ type: "favicon", host, uri: had > 0 ? `${uri}#${width}` : uri });

          return true;
        }).pipe(Effect.onError(() => files.delete(ROOT, partPath(host)).pipe(Effect.ignore)));

      /** Whether a site's icon is sharp enough to stop looking for a wider one. */
      const sharp = (host: string) => Effect.map(widthOf(host), (width) => width >= SHARP_WIDTH);

      /** The icon the page names; its site's touch icon too while that is too small to stay sharp. */
      const download = (view: Tab, host: string, url: string) =>
        Effect.gen(function* () {
          const icon = yield* engine.runPageScript<unknown>(view, FAVICON_SCRIPT);

          if (!v.is(faviconSourceSchema, icon) || !icon || !/^https?:/.test(icon.href)) return;

          yield* Ref.set(userAgent, icon.userAgent);
          // A page icon that fails or is a page still leaves the touch icon to try.
          yield* save(host, icon.href, icon.userAgent).pipe(Effect.catch(() => Effect.succeed(false)));

          if (!(yield* sharp(host)) && icon.href !== new URL(TOUCH_ICON, url).href) yield* save(host, new URL(TOUCH_ICON, url).href, icon.userAgent);
        });

      /** A known site's icon, from where sites usually keep it; the next path while none is sharp. */
      const downloadKnown = (host: string) =>
        atOnce.withPermits(1)(
          Effect.gen(function* () {
            const agent = yield* Ref.get(userAgent);

            for (const path of KNOWN_ICON_PATHS) {
              if (yield* sharp(host)) return;

              // A path that isn't there fails its download: try the next.
              yield* save(host, `https://${host}${path}`, agent).pipe(Effect.catch(() => Effect.succeed(false)));
            }
          }),
        );

      /** Asks once a launch for a site's icon from where sites usually keep it. */
      const askKnown = (host: string) => {
        asked.add(host);

        return FiberMap.run(jobs, host, { onlyIfMissing: true })(bestEffort({ name: "favicons.download", resource: host }, downloadKnown(host)));
      };

      /** Asks for the icons of known sites without one, and wider ones for icons too small to stay sharp. */
      const fillKnown = (data: BrowserData) =>
        Effect.gen(function* () {
          yield* Effect.forEach(
            knownSitesWithoutIcons(data).filter((host) => !asked.has(host)),
            askKnown,
            { discard: true },
          );

          const saved = Object.keys(data.favicons)
            .filter((host) => !asked.has(host))
            .slice(-KNOWN_LIMIT);

          for (const host of saved) {
            if (!(yield* sharp(host))) yield* askKnown(host);
            else asked.add(host);
          }
        });

      /** Deletes the files of sites whose icons the store dropped, wherever this or an earlier version kept them. */
      const forget = (hosts: readonly string[]) =>
        Effect.forEach(
          hosts,
          (host) =>
            bestEffort({ name: "favicons.delete", resource: host }, Effect.andThen(files.delete(ROOT, iconPath(host)), files.delete(OLD_ROOT, iconPath(host)))),
          { discard: true },
        );

      return Favicons.of({
        fetch: (view, url) =>
          bestEffort(
            { name: "favicons.fetch", resource: url },
            Effect.gen(function* () {
              const host = siteHost(url);

              // A site with an icon is asked again only while its icon is too small, once a launch.
              if (!host || ((yield* browserState.data()).favicons[host] && (pageAsked.has(host) || (yield* sharp(host))))) return;

              if ((yield* browserState.data()).favicons[host]) pageAsked.add(host);

              yield* FiberMap.run(jobs, host, { onlyIfMissing: true })(bestEffort({ name: "favicons.download", resource: host }, download(view, host, url)));
            }),
          ),
        start: Effect.gen(function* () {
          // The store's listener is a plain callback: it hands the deletions to fibers that live on the app scope.
          const run = yield* FiberSet.runtime(yield* FiberSet.make())<never>();

          yield* browserState.subscribe((data, previous) => {
            if (data.favicons !== previous.favicons) {
              // An icon's file is named after its site, so a site whose icon was replaced still has its file.
              const dropped = Object.keys(previous.favicons).filter((host) => !Object.hasOwn(data.favicons, host));

              // A dropped icon (its file is gone, or it wasn't an image) may be asked for again.
              for (const host of dropped) {
                asked.delete(host);
                pageAsked.delete(host);
                widths.delete(host);
              }

              if (dropped.length > 0) run(forget(dropped));
            }

            if (
              data.history !== previous.history ||
              data.bookmarks !== previous.bookmarks ||
              data.tabs !== previous.tabs ||
              data.favicons !== previous.favicons
            ) {
              run(fillKnown(data));
            }
          });

          // The sites Bay showed before this launch, once the saved tabs are in, without holding up the launch.
          run(
            Effect.gen(function* () {
              yield* browserState.awaitReady();
              yield* fillKnown(yield* browserState.data());
            }).pipe(Effect.ignore),
          );
        }),
      });
    }),
  );
}
