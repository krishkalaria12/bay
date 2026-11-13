// The content blocker: both engines block with the filter lists while the blockContent preference is on, and the
// lists stay fresh. The service follows the preference on the app scope. Turning blocking on applies the lists already
// downloaded, then refreshes the stale ones and applies again if any changed; turning it off interrupts a refresh that
// is still running, so nothing it was doing lands afterwards.
//
// List text never passes through JavaScript: lists download straight to files, their versions come from native MD5
// digests, and the engines read the files themselves. (7 MB of text on the JS thread made typing drop keystrokes.)
import { TRACKING_PARAMS } from "@bay/core/src/cleanUrl.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { BrowserState } from "../effect/ports/browserState.ts";
import { Diagnostics } from "../effect/ports/diagnostics.ts";
import { Engine, type EngineError } from "../effect/ports/engine.ts";
import { Files, type FileError } from "../effect/ports/files.ts";
import { Http } from "../effect/ports/http.ts";
import type { BrowserData } from "../store/types.ts";
import { useBlockerStatus, type BlockerStatus } from "./contentBlocking.ts";
import { ENGINE_RULES, FILTER_LISTS, isStale, listUnchanged, listVersion, looksLikeFilterList, type ListValidators } from "./filterLists.ts";

/** Where the lists live, in the app's documents. */
const DIRECTORY = "filter-lists";

/** When each list was fetched and what the server said about it. Only a refresh writes it, one at a time. */
export const META_PATH = `${DIRECTORY}/lists.json`;

/** How long a server has to answer the HEAD request that says whether a list changed. */
export const HEAD_TIMEOUT = 10_000;

/** How many lists refresh at once: all of them, each on its own. */
const REFRESH_CONCURRENCY = 8;

/** How much of a download is read to tell a filter list from an error page. */
const HEAD_BYTES = 512;

type FilterList = (typeof FILTER_LISTS)[number];

type ListMeta = { fetchedAt: number } & ListValidators;

type Meta = Record<string, ListMeta>;

/** What refreshing one list did: what to remember about it, and whether its file changed. */
type Refreshed = { readonly meta: ListMeta; readonly changed: boolean };

export const listPath = (id: string): string => `${DIRECTORY}/${id}.txt`;

/** Where a list downloads to before it replaces the saved copy. */
const downloadPath = (id: string): string => `${DIRECTORY}/${id}.download`;

const hostOf = (url: string): string => url.split("/")[2] ?? url;

const setStatus = (status: BlockerStatus) => Effect.sync(() => useBlockerStatus.setState({ status }));

export class Blocker extends Context.Service<
  Blocker,
  {
    /**
     * Sets the tracking-parameter table and follows the preferences from the moment the saved state is read. The
     * work it starts belongs to the scope it was started in.
     */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("bay/Blocker") {
  static readonly layer = Layer.effect(
    Blocker,
    Effect.gen(function* () {
      const files = yield* Files;
      const http = yield* Http;
      const engine = yield* Engine;
      const browserState = yield* BrowserState;
      const diagnostics = yield* Diagnostics;

      // One apply at a time: the engines compile what they are given, and the last call has to be the one that wins.
      const applying = yield* Semaphore.make(1);
      // One writer for lists.json: a refresh reads it, refreshes the lists and writes it back.
      const metaWriter = yield* Semaphore.make(1);
      // One download at a time from each server.
      const turns = new Map<string, Semaphore.Semaphore>();

      const turnFor = (url: string): Semaphore.Semaphore => {
        const host = hostOf(url);
        const existing = turns.get(host);

        if (existing) return existing;

        const turn = Semaphore.makeUnsafe(1);

        turns.set(host, turn);

        return turn;
      };

      // SAFETY: only writeMeta writes the file, as JSON Meta, so its text parses to Meta (or null).
      const decodeMeta = (text: string | null): Meta => (text ? ((JSON.parse(text) as Meta | null) ?? {}) : {});

      /** The saved metadata. A file that can't be read or parsed starts over, and every list is refreshed. */
      const readMeta = files.read("document", META_PATH).pipe(
        Effect.flatMap((text) => Effect.try(() => decodeMeta(text))),
        Effect.orElseSucceed((): Meta => ({})),
      );

      /** Writes the metadata as it is when the write runs, not when it was asked for. */
      const writeMeta = (meta: Meta) =>
        Effect.suspend(() => files.write("document", META_PATH, JSON.stringify(meta))).pipe(
          Effect.catch((error) => diagnostics.warn(`Couldn't save the filter lists' metadata: ${String(error.cause)}`)),
        );

      /** A list's ETag and Last-Modified from a HEAD request (headers only, no list text), or null if the server didn't answer. */
      const headValidators = (url: string): Effect.Effect<ListValidators | null> =>
        http.send({ url, method: "HEAD" }).pipe(
          Effect.timeout(HEAD_TIMEOUT),
          Effect.map((response): ListValidators => {
            const etag = response.headers.get("etag");
            const lastModified = response.headers.get("last-modified");

            return { ...(etag ? { etag } : undefined), ...(lastModified ? { lastModified } : undefined) };
          }),
          // A server that fails or is slow to answer says nothing about the list, so it is downloaded.
          Effect.orElseSucceed(() => null),
        );

      /** Downloads a list and puts it in place if it is a list and it changed. Nothing is kept when it isn't one. */
      const download = (list: FilterList, validators: ListValidators | null, now: number): Effect.Effect<Refreshed | undefined, FileError> => {
        const temporary = downloadPath(list.id);
        const target = listPath(list.id);

        return Effect.gen(function* () {
          yield* files.delete("document", temporary);
          yield* files.download("document", temporary, list.url);

          const size = yield* files.size("document", temporary);
          const head = yield* files.head("document", temporary, HEAD_BYTES);

          if (!looksLikeFilterList(head, size)) return undefined;

          const same =
            (yield* files.exists("document", target)) &&
            (yield* files.digest("document", target, "MD5")) === (yield* files.digest("document", temporary, "MD5"));

          if (!same) yield* files.move("document", temporary, target);

          return { meta: { fetchedAt: now, ...validators }, changed: !same };
        }).pipe(
          // However the download ended (put in place, failed, or interrupted because blocking was turned off), the
          // temporary file goes.
          Effect.ensuring(
            files.delete("document", temporary).pipe(Effect.catch((error) => diagnostics.warn(`Couldn't remove ${temporary}: ${String(error.cause)}`))),
          ),
        );
      };

      /** Refreshes one list if it is stale. A list whose server says it is unchanged isn't downloaded again. */
      const refreshList = (list: FilterList, saved: ListMeta | undefined, now: number): Effect.Effect<Refreshed | undefined, FileError> =>
        Effect.gen(function* () {
          const cached = yield* files.exists("document", listPath(list.id));

          // A missing file is stale whatever the metadata says.
          if (cached && !isStale(saved?.fetchedAt, now)) return undefined;

          // The lists are 7 MB together: skip the download when the server says the saved copy is current.
          const validators = yield* headValidators(list.url);

          if (saved && validators && cached && listUnchanged(saved, validators)) return { meta: { ...saved, fetchedAt: now }, changed: false };

          return yield* download(list, validators, now);
        });

      /**
       * Refreshes the stale lists, each on its own: one that fails keeps its saved copy and is tried again on the next
       * launch or the next time blocking is turned on. Returns whether any list changed.
       */
      const refresh = metaWriter.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;

          yield* files.createDirectory("document", DIRECTORY);

          const meta = yield* readMeta;
          let changed = false;

          yield* Effect.forEach(
            FILTER_LISTS,
            (list) =>
              Effect.gen(function* () {
                const refreshed = yield* turnFor(list.url)
                  .withPermits(1)(refreshList(list, meta[list.id], now))
                  .pipe(
                    Effect.catch((error) => Effect.as(diagnostics.warn(`Couldn't update the ${list.title} filter list: ${String(error.cause)}`), undefined)),
                  );

                if (!refreshed) return;

                meta[list.id] = refreshed.meta;
                changed ||= refreshed.changed;
              }),
            { concurrency: REFRESH_CONCURRENCY, discard: true },
          ).pipe(
            // What finished is kept even when the rest was interrupted, so a list that came down isn't fetched again.
            Effect.ensuring(writeMeta(meta)),
          );

          return changed;
        }),
      );

      /** Hands the engines the lists on disk, or says they are still coming when there are none yet. */
      const applyLists = applying.withPermits(1)(
        Effect.gen(function* () {
          const present = (yield* Effect.forEach(
            FILTER_LISTS,
            (list) => Effect.map(files.exists("document", listPath(list.id)), (exists) => (exists ? [list] : [])),
            {
              concurrency: "unbounded",
            },
          )).flat();

          if (!present.length) return yield* setStatus({ state: "loading" });

          const digests = yield* Effect.forEach(present, (list) => files.digest("document", listPath(list.id), "MD5"), { concurrency: "unbounded" });
          const uris = yield* Effect.forEach(present, (list) => files.uri("document", listPath(list.id)));

          // A call the engines were given settles before the next apply starts, so turning blocking off never lands
          // ahead of a list that was still being applied.
          yield* Effect.uninterruptible(
            Effect.andThen(
              engine.setContentBlocking(uris, listVersion([ENGINE_RULES, ...digests].join(":"))),
              setStatus({ state: "ready", lists: present.length }),
            ),
          );
        }),
      );

      const applyOff = applying.withPermits(1)(Effect.uninterruptible(Effect.andThen(engine.setContentBlocking(null, ""), setStatus({ state: "off" }))));

      const failed = (error: FileError | EngineError) =>
        Effect.andThen(
          diagnostics.report({ operation: { name: "blocker.apply" }, message: "Couldn't start the content blocker.", cause: error }),
          setStatus({ state: "failed" }),
        );

      const turnOn = Effect.gen(function* () {
        yield* applyLists;

        if (yield* refresh) yield* applyLists;
      }).pipe(Effect.catch(failed));

      const turnOff = applyOff.pipe(Effect.catch(failed));

      /** Where blocking is paused. It is a plain native call, and the latest list of hosts is the one that lands. */
      const pause = (hosts: readonly string[]) =>
        engine
          .setBlockingPausedHosts(hosts)
          .pipe(Effect.catch((error) => diagnostics.report({ operation: { name: "blocker.pause" }, message: "Couldn't pause blocking.", cause: error })));

      return Blocker.of({
        start: Effect.gen(function* () {
          // The table is the same for every page, so it is set once.
          yield* engine
            .setTrackingParameters(TRACKING_PARAMS)
            .pipe(
              Effect.catch((error) =>
                diagnostics.report({ operation: { name: "blocker.trackingParameters" }, message: "Couldn't set the tracking parameters.", cause: error }),
              ),
            );

          // Each runs one fiber at a time: a new preference interrupts the work the previous one started.
          const follow = yield* FiberHandle.makeRuntime<never>();
          const pausing = yield* FiberHandle.makeRuntime<never>();

          let enabled: boolean | undefined;
          let paused: readonly string[] | undefined;

          const sync = (data: BrowserData): void => {
            const { blockContent, blockingPausedHosts } = data.preferences;

            if (blockingPausedHosts !== paused) {
              paused = blockingPausedHosts;
              pausing(pause(blockingPausedHosts));
            }

            if (blockContent !== enabled) {
              enabled = blockContent;
              follow(blockContent ? turnOn : turnOff);
            }
          };

          yield* Effect.forkScoped(
            Effect.gen(function* () {
              // Until the saved state is read, the preferences are the defaults and not the user's.
              yield* browserState.awaitReady();
              yield* browserState.subscribe(sync);

              sync(yield* browserState.data());
            }).pipe(
              Effect.catch((error) => diagnostics.report({ operation: { name: "blocker.start" }, message: "Couldn't read the preferences.", cause: error })),
            ),
          );
        }),
      });
    }),
  );
}
