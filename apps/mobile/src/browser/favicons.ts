// Site icons come from the site itself while it's open (no third-party icon service learns what you browse), are
// downloaded once without cookies, and are drawn from the local copy afterwards, so showing them makes no requests.
// One job per site runs at a time, however many tabs open it, and clearing history or browsing data deletes the
// files of the icons it drops. Icons are best effort: a failure is dropped and the next visit tries again.
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
import { FAVICON_SCRIPT } from "../pagescripts/favicon.ts";
import { siteHost } from "../store/model.ts";

/** Where the icons are kept, in the cache. */
const FOLDER = "favicons";

/** Smaller than this isn't an image. */
const MIN_BYTES = 16;

/** Larger than this isn't an icon. */
const MAX_BYTES = 64 * 1024;

/** The icon the page links to, and the user agent to ask for it with. The page can answer with anything. */
const faviconSourceSchema = v.nullable(v.object({ href: v.string(), userAgent: v.string() }));

/** An icon's file, named after its site. */
const iconPath = (host: string) => `${FOLDER}/${encodeURIComponent(host)}`;

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

      /** Drops the failures an icon is expected to have, and reports a defect. */
      const bestEffort = <E, R>(operation: Operation, effect: Effect.Effect<void, E, R>): Effect.Effect<void, never, R> =>
        effect.pipe(
          Effect.catch(() => Effect.void),
          Effect.catchDefect((defect) => {
            const error = defect instanceof Error ? defect : new Error(String(defect));

            return diagnostics.report({ operation, message: error.message, cause: error });
          }),
        );

      const download = (view: Tab, host: string) =>
        Effect.gen(function* () {
          const icon = yield* engine.runPageScript<unknown>(view, FAVICON_SCRIPT);

          if (!v.is(faviconSourceSchema, icon) || !icon || !/^https?:/.test(icon.href)) return;

          const path = iconPath(host);

          yield* files.createDirectory("cache", FOLDER);
          yield* files.download("cache", path, icon.href, { "User-Agent": icon.userAgent, Accept: "image/*" });

          const size = yield* files.size("cache", path);

          if (size < MIN_BYTES || size > MAX_BYTES) return yield* files.delete("cache", path);

          yield* browserState.dispatch({ type: "favicon", host, uri: yield* files.uri("cache", path) });
        });

      /** Deletes the files of sites whose icons the store dropped. */
      const forget = (hosts: readonly string[]) =>
        Effect.forEach(hosts, (host) => bestEffort({ name: "favicons.delete", resource: host }, files.delete("cache", iconPath(host))), { discard: true });

      return Favicons.of({
        fetch: (view, url) =>
          bestEffort(
            { name: "favicons.fetch", resource: url },
            Effect.gen(function* () {
              const host = siteHost(url);

              if (!host || (yield* browserState.data()).favicons[host]) return;

              yield* FiberMap.run(jobs, host, { onlyIfMissing: true })(bestEffort({ name: "favicons.download", resource: host }, download(view, host)));
            }),
          ),
        start: Effect.gen(function* () {
          // The store's listener is a plain callback: it hands the deletions to fibers that live on the app scope.
          const run = yield* FiberSet.runtime(yield* FiberSet.make())<never>();

          yield* browserState.subscribe((data, previous) => {
            if (data.favicons === previous.favicons) return;

            // An icon's file is named after its site, so a site whose icon was replaced still has its file.
            const dropped = Object.keys(previous.favicons).filter((host) => !Object.hasOwn(data.favicons, host));

            if (dropped.length > 0) run(forget(dropped));
          });
        }),
      });
    }),
  );
}
