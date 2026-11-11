// The app's enrichment: the icon a page has, what that icon looks like, a tab's picture and a page's artwork.
//
// The plain half stays plain: the maths that picks a colour, the reads of the cache and the drawing itself are on
// the hot path, and nothing waits in front of them. What is here is the other half — the asking, the waiting, the
// batching, and the owning of the work that is still to come, so that an answer for a page that has gone never
// lands on it.
//
// The requests come from a render path and from native callbacks, where there is nothing to wait for, so they are
// queued here in plain state and the service does the waiting: a hundred icons are one lookup and one fiber, not a
// hundred of each.
import { faviconsFor, fetchFavicon } from "@bay/chromium";
import { iconTheme, type IconTheme } from "@bay/desktop";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ARTWORK_MAX_PIXELS } from "../components/media/constants";
import type { Operation } from "../effect/errors";
import { Diagnostics } from "../effect/ports/diagnostics";
import { useBrowser } from "../store/browserStore";
import { FAVICON_LOOKUP_BATCH, FAVICON_LOOKUP_DELAY_MS, PICTURE_SETTLE_MS } from "./constants";
import { webviews } from "./webviews";

// MARK: The port

/** The Mac could not answer what was asked of it. */
export class EnrichmentFailure extends TaggedError("EnrichmentFailure")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** A tab's picture, as the page drew it. The frame is the page's own rectangle, as the native side gives it. */
export type Picture = { readonly data: string; readonly frame: [number, number, number, number] };

/** The native side of the enrichment, as the service reaches it. */
export class EnrichmentEngine extends Context.Service<
  EnrichmentEngine,
  {
    /** The icons Chrome has for pages of a profile. A page it has no icon for is answered with nothing. */
    readonly favicons: (profile: string, pages: readonly string[]) => Effect.Effect<ReadonlyMap<string, string | null>, EnrichmentFailure>;
    /** An icon a tab's own page fetches, with the page's own session. */
    readonly icon: (tabId: string, src: string) => Effect.Effect<string | null, EnrichmentFailure>;
    /** An icon Chrome does not have, fetched without cookies and handed to Chrome. */
    readonly favicon: (url: string, profile: string, page: string) => Effect.Effect<string | null, EnrichmentFailure>;
    /** What the Mac says an icon looks like. */
    readonly theme: (uri: string) => Effect.Effect<IconTheme | null, EnrichmentFailure>;
    /** The tab's last picture. */
    readonly picture: (tabId: string) => Effect.Effect<Picture | null, EnrichmentFailure>;
    /** The page's artwork. */
    readonly artwork: (tabId: string, url: string) => Effect.Effect<string | null, EnrichmentFailure>;
  }
>()("bay/EnrichmentEngine") {
  static readonly layer = Layer.succeed(EnrichmentEngine)({
    favicons: (profile, pages) =>
      Effect.tryPromise({
        try: () => faviconsFor(profile, [...pages]),
        catch: (cause) => new EnrichmentFailure({ operation: { name: "enrichment.favicons", resource: profile }, cause }),
      }).pipe(
        Effect.map((found) => {
          const answers = new Map<string, string | null>();

          for (const page of pages) answers.set(page, found.pages.get(page)?.uri ?? null);

          return answers;
        }),
      ),
    icon: (tabId, src) =>
      Effect.suspend(() => {
        const view = webviews.get(tabId);

        if (!view) return Effect.succeed(null);

        return Effect.tryPromise({
          try: () => view.downloadFavicon(src),
          catch: (cause) => new EnrichmentFailure({ operation: { name: "enrichment.icon", resource: src }, cause }),
        }).pipe(Effect.map((image) => image?.uri ?? null));
      }),
    favicon: (url, profile, page) =>
      Effect.tryPromise({
        try: () => fetchFavicon(url, profile, page),
        catch: (cause) => new EnrichmentFailure({ operation: { name: "enrichment.favicon", resource: url }, cause }),
      }).pipe(Effect.map((image) => image?.uri ?? null)),
    theme: (uri) =>
      Effect.tryPromise({
        try: () => iconTheme({ uri }),
        catch: (cause) => new EnrichmentFailure({ operation: { name: "enrichment.theme", resource: uri }, cause }),
      }).pipe(Effect.map((theme) => theme ?? null)),
    picture: (tabId) =>
      Effect.suspend(() => {
        const view = webviews.get(tabId);

        if (!view) return Effect.succeed(null);

        return Effect.tryPromise({
          try: () => view.capturePicture(0.25),
          catch: (cause) => new EnrichmentFailure({ operation: { name: "enrichment.picture", resource: tabId }, cause }),
        }).pipe(Effect.map((picture) => picture ?? null));
      }),
    artwork: (tabId, url) =>
      Effect.suspend(() => {
        const view = webviews.get(tabId);

        if (!view) return Effect.succeed(null);

        return Effect.tryPromise({
          try: () => view.downloadImage(url, ARTWORK_MAX_PIXELS),
          catch: (cause) => new EnrichmentFailure({ operation: { name: "enrichment.artwork", resource: url }, cause }),
        }).pipe(Effect.map((image) => image?.uri ?? null));
      }),
  });
}

// MARK: The requests

/** What the app asks for, and where the answer goes. */
export type FaviconRequest = {
  /** The profile whose Chrome keeps the icons. */
  readonly profile: string;
  /** The page, without its fragment. */
  readonly page: string;
  /** Where the answer goes: the icons of one lookup, at once, so a burst of icons is one write. */
  readonly onAnswers: (icons: ReadonlyMap<string, string | null>) => void;
  /** The lookup failed: the page is asked again the next time it is shown. */
  readonly onFailed?: () => void;
};

/** An icon that is fetched, and where it goes. */
export type IconRequest = {
  /** The profile the icon belongs to. */
  readonly profile: string;
  /** The page the icon is of. */
  readonly page: string;
  /** The icon's own address. */
  readonly src: string;
  /** The tab whose own page fetches the icon, or nothing when the app fetches it without cookies. */
  readonly tabId: string | null;
  /** Where the answer goes. */
  readonly onIcon: (uri: string | null) => void;
};

/** What the Mac says about an icon, and where it goes. */
export type ThemeRequest = {
  /** The icon the Mac is asked about. */
  readonly uri: string;
  /** Where the answer goes. */
  readonly onTheme: (theme: IconTheme | null) => void;
};

/** A tab's picture, and where it goes. */
export type PictureRequest = {
  /** The window whose tab is photographed. */
  readonly windowId: string;
  /** The tab to photograph. */
  readonly tabId: string;
  /** Where the picture goes. */
  readonly onPicture: (picture: Picture | null) => void;
};

/** A page's artwork, and where it goes. */
export type ArtworkRequest = {
  /** The tab the artwork belongs to. */
  readonly tabId: string;
  /** The artwork's own address. */
  readonly url: string;
  /** Where the artwork goes. */
  readonly onArtwork: (uri: string | null) => void;
};

// MARK: The work waiting

// The pages waiting for Chrome's answer, by profile and page. Plain on purpose: the icons are asked for from a
// render path, so a hundred of them cost a hundred map writes and not a hundred fibers.
// The burst takes these by swapping in empty ones: a map that is emptied in place would empty the work it took.
let queuedIcons = new Map<string, Map<string, FaviconRequest>>();

// The icons that are fetched, by profile and address. The pages that report the same icon share one fetch.
let queuedFetches = new Map<string, Set<IconRequest>>();

// The icons waiting for the Mac's answer.
let queuedThemes = new Map<string, ThemeRequest>();

// The windows waiting for their tab's picture.
let queuedPictures = new Map<string, PictureRequest>();

// The pages waiting for their artwork, by tab and address.
let queuedArtworks = new Map<string, ArtworkRequest>();

// The artwork that is on its way, and the one that was forgotten while it was.
const runningArtworks = new Set<string>();
const forgottenArtworks = new Set<string>();

// What each profile's icons are at: the number moves when the profile is forgotten, and an answer that was asked
// for before the move is not the answer the profile has now.
const generations = new Map<string, number>();

// The pages whose answer is on its way, and the ones that were forgotten while it was.
const inFlight = new Set<string>();
const forgotten = new Set<string>();

// The burst's fiber. It is set when the app's runtime builds the service, and it is what does the waiting.
let startBurst: (() => void) | undefined;

// Whether the burst is up, and whether work arrived while it was ending.
let bursting = false;
let again = false;

/** The key a page's pending work is remembered under. */
const pageKey = (profile: string, page: string) => `${profile}|${page}`;

/** The key an icon's pending fetch is remembered under. */
const fetchKey = (profile: string, src: string) => `${profile}|${src}`;

/** The key an artwork's pending work is remembered under. */
const artworkKey = (tabId: string, url: string) => `${tabId} ${url}`;

// MARK: The door

/** Asks Chrome for the icons of pages that have none yet. The pages of one burst make one lookup. */
export const askFavicons = (request: FaviconRequest): void => {
  const pages = queuedIcons.get(request.profile) ?? new Map<string, FaviconRequest>();

  pages.set(request.page, request);
  queuedIcons.set(request.profile, pages);
  startBurst?.();
};

/** Asks for an icon. The pages that report the same icon share one fetch. */
export const askIcon = (request: IconRequest): void => {
  const key = fetchKey(request.profile, request.src);
  const waiting = queuedFetches.get(key) ?? new Set<IconRequest>();

  waiting.add(request);
  queuedFetches.set(key, waiting);
  startBurst?.();
};

/** Asks the Mac what an icon looks like. */
export const askTheme = (request: ThemeRequest): void => {
  queuedThemes.set(request.uri, request);
  startBurst?.();
};

/** Asks for a tab's picture. The window's last request is the one that counts. */
export const askPicture = (request: PictureRequest): void => {
  queuedPictures.set(request.windowId, request);
  startBurst?.();
};

/** Asks for a page's artwork. An artwork that is on its way is not asked for again. */
export const askArtwork = (request: ArtworkRequest): void => {
  const key = artworkKey(request.tabId, request.url);

  if (runningArtworks.has(key)) return;

  queuedArtworks.set(key, request);
  startBurst?.();
};

/** Forgets a profile's icons: the work that was on its way is not the profile's any more. */
export const forgetProfile = (profile: string): void => {
  generations.set(profile, (generations.get(profile) ?? 0) + 1);

  const pages = queuedIcons.get(profile);

  if (!pages) return;

  for (const page of pages.keys()) {
    const key = pageKey(profile, page);

    if (inFlight.has(key)) forgotten.add(key);
  }

  queuedIcons.delete(profile);
};

/** Forgets a page: an answer that was on its way is not the page's any more. */
export const forgetPage = (profile: string, page: string): void => {
  const key = pageKey(profile, page);

  queuedIcons.get(profile)?.delete(page);

  if (inFlight.has(key)) forgotten.add(key);
};

/** Forgets a tab: the artwork that was on its way is not the tab's any more. */
export const forgetTab = (tabId: string): void => {
  for (const key of queuedArtworks.keys()) if (key.startsWith(`${tabId} `)) queuedArtworks.delete(key);

  for (const key of runningArtworks) if (key.startsWith(`${tabId} `)) forgottenArtworks.add(key);
};

/** What the service is holding right now. */
export const held = (): readonly string[] => {
  const names: string[] = [];

  if (bursting) names.push("burst");

  for (const profile of queuedIcons.keys()) names.push(`icons:${profile}`);

  for (const key of queuedFetches.keys()) names.push(`icon:${key}`);

  for (const uri of queuedThemes.keys()) names.push(`theme:${uri}`);

  for (const windowId of queuedPictures.keys()) names.push(`picture:${windowId}`);

  for (const key of queuedArtworks.keys()) names.push(`artwork:${key}`);

  for (const key of runningArtworks) names.push(`artwork:${key}`);

  for (const key of inFlight) names.push(`icons:${key}`);

  return names;
};

/** Whether something is waiting to be looked up. */
const waiting = () => queuedIcons.size > 0 || queuedFetches.size > 0 || queuedThemes.size > 0 || queuedPictures.size > 0 || queuedArtworks.size > 0;

// MARK: The service

/** The app's enrichment: the icons, the themes, the pictures and the artwork, and the work behind them. */
export class EnrichmentService extends Context.Service<
  EnrichmentService,
  {
    /** Asks Chrome for the icons of pages that have none yet. The pages of one burst make one lookup. */
    readonly requestFavicons: (request: FaviconRequest) => void;
    /** Asks for an icon that Chrome does not have. */
    readonly requestIcon: (request: IconRequest) => void;
    /** Asks the Mac what an icon looks like. */
    readonly requestTheme: (request: ThemeRequest) => void;
    /** Takes a tab's picture, once the tab has settled. */
    readonly requestPicture: (request: PictureRequest) => void;
    /** Asks for a page's artwork. */
    readonly requestArtwork: (request: ArtworkRequest) => void;
    /** Forgets a profile's icons, and the work that was on its way. */
    readonly invalidateProfile: (profile: string) => void;
    /** Forgets a page: an answer that was on its way is not the page's any more. */
    readonly forgetPage: (profile: string, page: string) => void;
    /** Forgets a tab: the picture and the artwork that were on their way are not the tab's any more. */
    readonly forgetTab: (tabId: string) => void;
    /** What the service is holding right now. */
    readonly held: () => readonly string[];
  }
>()("bay/EnrichmentService") {
  static readonly layer = Layer.effect(
    EnrichmentService,
    Effect.gen(function* () {
      const engine = yield* EnrichmentEngine;
      const diagnostics = yield* Diagnostics;
      const clock = yield* Clock.Clock;
      const scope = yield* Scope.Scope;

      // A failure the service could not carry is reported once, where every other failure goes.
      const report = (operation: Operation, cause: Cause.Cause<unknown>) =>
        Effect.gen(function* () {
          const failure = Cause.squash(cause);
          const error = failure instanceof Error ? failure : new Error(String(failure));

          yield* diagnostics.report({ operation, message: error.message, cause: error });
        });

      // The icons Chrome has for the pages of a profile. The pages of one burst are one lookup, and the answer of
      // one lookup is one write.
      const lookUpIcons = (batches: Map<string, Map<string, FaviconRequest>>) =>
        Effect.gen(function* () {
          for (const [profile, requests] of batches) {
            const pages = [...requests.keys()];

            for (let i = 0; i < pages.length; i += FAVICON_LOOKUP_BATCH) {
              const chunk = pages.slice(i, i + FAVICON_LOOKUP_BATCH);
              const generation = generations.get(profile) ?? 0;

              for (const page of chunk) inFlight.add(pageKey(profile, page));

              const outcome = yield* Effect.exit(engine.favicons(profile, chunk));

              for (const page of chunk) inFlight.delete(pageKey(profile, page));

              if (Exit.isFailure(outcome)) {
                // The lookup failed: it is reported once, and the pages are asked again the next time they are shown.
                yield* report({ name: "enrichment.favicons", resource: profile }, outcome.cause);

                for (const page of chunk) requests.get(page)?.onFailed?.();

                continue;
              }

              // The profile was forgotten while the answer was on its way: it is not the profile's answer any more.
              if ((generations.get(profile) ?? 0) !== generation) continue;

              const answers = new Map<(icons: ReadonlyMap<string, string | null>) => void, Map<string, string | null>>();

              for (const page of chunk) {
                // The page was forgotten while its answer was on its way.
                if (forgotten.delete(pageKey(profile, page))) continue;

                const request = requests.get(page);

                if (!request) continue;

                let group = answers.get(request.onAnswers);

                if (!group) answers.set(request.onAnswers, (group = new Map()));

                group.set(page, outcome.value.get(page) ?? null);
              }

              for (const [sink, icons] of answers) sink(icons);
            }
          }
        });

      // The icons that are fetched: the pages that report the same icon share one fetch.
      const fetchIcons = (fetches: Map<string, Set<IconRequest>>) =>
        Effect.gen(function* () {
          for (const [key, requests] of fetches) {
            const first = requests.values().next().value;

            if (!first) continue;

            const outcome = first.tabId
              ? yield* Effect.exit(engine.icon(first.tabId, first.src))
              : yield* Effect.exit(engine.favicon(first.src, first.profile, first.page));

            if (Exit.isFailure(outcome)) {
              yield* report({ name: "enrichment.icon", resource: key }, outcome.cause);

              for (const request of requests) request.onIcon(null);

              continue;
            }

            for (const request of requests) request.onIcon(outcome.value);
          }
        });

      // What the Mac says about the icons that are waiting. The whole burst is one round of colour analysis.
      const analyseThemes = (themes: Map<string, ThemeRequest>) =>
        Effect.gen(function* () {
          for (const [uri, request] of themes) {
            const outcome = yield* Effect.exit(engine.theme(uri));

            if (Exit.isFailure(outcome)) {
              yield* report({ name: "enrichment.theme", resource: uri }, outcome.cause);

              continue;
            }

            request.onTheme(outcome.value);
          }
        });

      // A window's tab is photographed once it has been shown for a moment: a page out of view is not painted, so
      // it cannot be captured then.
      const takePicture = (request: PictureRequest) =>
        Effect.gen(function* () {
          yield* clock.sleep(Duration.millis(PICTURE_SETTLE_MS));

          if (!shownTab(request.windowId, request.tabId)) return;

          const outcome = yield* Effect.exit(engine.picture(request.tabId));

          if (Exit.isFailure(outcome)) {
            yield* report({ name: "enrichment.picture", resource: request.tabId }, outcome.cause);

            return;
          }

          // The window shows another tab now: the picture would be of a tab that is not there.
          if (!shownTab(request.windowId, request.tabId)) return;

          request.onPicture(outcome.value);
        });

      // The artwork of a page, as the page's own view drew it.
      const takeArtwork = (request: ArtworkRequest, key: string) =>
        Effect.gen(function* () {
          const outcome = yield* Effect.exit(engine.artwork(request.tabId, request.url));

          runningArtworks.delete(key);

          if (Exit.isFailure(outcome)) {
            yield* report({ name: "enrichment.artwork", resource: request.url }, outcome.cause);

            return;
          }

          // The tab was forgotten while the artwork was on its way: it is not the tab's any more.
          if (forgottenArtworks.delete(key)) return;

          if (!useBrowser.getState().tabs[request.tabId]) return;

          request.onArtwork(outcome.value);
        });

      // The burst: everything that is waiting is looked up, and what arrives while the work runs waits for the
      // next round.
      const burst = Effect.gen(function* () {
        // The burst gathers: what is asked for in this window is one lookup.
        yield* clock.sleep(Duration.millis(FAVICON_LOOKUP_DELAY_MS));

        for (;;) {
          const icons = queuedIcons;
          const fetches = queuedFetches;
          const themes = queuedThemes;
          const pictures = queuedPictures;
          const artworks = queuedArtworks;

          queuedIcons = new Map();
          queuedFetches = new Map();
          queuedThemes = new Map();
          queuedPictures = new Map();
          queuedArtworks = new Map();

          yield* lookUpIcons(icons);
          yield* fetchIcons(fetches);
          yield* analyseThemes(themes);

          for (const request of pictures.values()) yield* Effect.forkIn(takePicture(request), scope, { startImmediately: true });

          for (const [key, request] of artworks) {
            runningArtworks.add(key);
            yield* Effect.forkIn(takeArtwork(request, key), scope, { startImmediately: true });
          }

          // Work that arrived while the burst was working is the next round's work.
          if (again) {
            again = false;
            continue;
          }

          if (!waiting()) return;
        }
      }).pipe(
        // An interruption is the scope closing, not a failure.
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => report({ name: "enrichment.burst" }, cause),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            bursting = false;

            // A request that arrived while the burst was ending is not left waiting for a burst that will not come.
            if (again || waiting()) {
              again = false;
              startBurst?.();
            }
          }),
        ),
      );

      startBurst = () => {
        if (bursting) {
          // The burst is already up: it will pick the work up when it looks again.
          again = true;

          return;
        }

        bursting = true;

        // The burst's fiber is the service's own: closing the service's scope stops it. It starts at once, so the
        // work it gathers is one burst from the first request.
        void Effect.runPromiseExit(Effect.forkIn(burst, scope, { startImmediately: true }));
      };

      // The service lets go of everything it holds when its scope closes.
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          startBurst = undefined;
          bursting = false;
          again = false;
          queuedIcons = new Map();
          queuedFetches = new Map();
          queuedThemes = new Map();
          queuedPictures = new Map();
          queuedArtworks = new Map();
          runningArtworks.clear();
          forgottenArtworks.clear();
          inFlight.clear();
          forgotten.clear();
          generations.clear();
        }),
      );

      // The work that was queued before the runtime was ready is looked up now.
      if (waiting()) startBurst();

      return EnrichmentService.of({
        requestFavicons: askFavicons,
        requestIcon: askIcon,
        requestTheme: askTheme,
        requestPicture: askPicture,
        requestArtwork: askArtwork,
        invalidateProfile: forgetProfile,
        forgetPage,
        forgetTab,
        held,
      });
    }),
  );
}

/** Whether the window still shows the tab, and the tab is still there. */
const shownTab = (windowId: string, tabId: string) => {
  const s = useBrowser.getState();
  const window = s.windows[windowId];

  return !!window && !!s.tabs[tabId] && window.activeTabIds[window.spaceId] === tabId;
};

/** What the enrichment can do. */
export type Enrichment = EnrichmentService["Service"];
