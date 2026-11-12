// Capture, as a job: the selection is put into the page, the picture is taken, and what the user does with it —
// copy, save, Library, an Easel, Portrait — runs to its end or not at all.
//
// A capture belongs to one tab and one document. Its generation moves when the user puts it away, retakes it, or
// the page leaves: a stage that comes back late finds another generation and does nothing, and the selection the
// page was given is taken away again whatever ended the job. The selection's script and the overlay stay plain
// (captureScript.ts, CaptureLayer.tsx): this file only decides when to ask the page for something.
import type { CapturedImage } from "@bay/chromium";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as v from "valibot";
import { create } from "zustand";
import type { Operation } from "../../effect/errors";
import { Diagnostics } from "../../effect/ports/diagnostics";
import { isJsonObject, type JsonInput } from "../../lib/json";
import { themeFor, themeKey } from "../../lib/theme";
import { useBrowser } from "../../store/browserStore";
import { engineProfile } from "../../store/model";
import type { Tab } from "../../store/types";
import { LibraryService } from "../library/libraryService";
import { webLink, type CaptureSource, type LibraryMedia } from "../library/model";
import { isInternalTab } from "../pages/internalPages";
import { showToast } from "../ui/toasts";
import { captureScript } from "./captureScript";
import { captureName } from "./regionGeometry";

// MARK: The state the app shows

/** What was taken, in the page's CSS px from the viewport's top-left, with the viewport's size then. */
export type CaptureArea = { x?: number; y?: number; left: number; top: number; width: number; height: number; viewportWidth: number; viewportHeight: number };

export type CaptureSession =
  | { phase: "selecting" | "shooting"; url: string }
  | { phase: "ready" | "markup"; url: string; image: CapturedImage; area: CaptureArea | null; name: string };

export const useCaptures = create<{ sessions: Record<string, CaptureSession> }>()(() => ({ sessions: {} }));

/** The capture a tab has, if it has one. */
export const sessionOf = (tabId: string): CaptureSession | null => useCaptures.getState().sessions[tabId] ?? null;

/** The capture's picture, once it is taken. */
export const readyOf = (tabId: string) => {
  const session = sessionOf(tabId);

  return session && (session.phase === "ready" || session.phase === "markup") ? session : null;
};

/** Puts a capture in a tab's place, or takes it away. */
export function setSession(tabId: string, session: CaptureSession | null) {
  useCaptures.setState((c) => {
    const sessions = { ...c.sessions };

    if (session) sessions[tabId] = session;
    else delete sessions[tabId];

    return { sessions };
  });
}

// MARK: The port

/** The native side could not do what was asked. */
export class CaptureFailure extends TaggedError("CaptureFailure")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** How the page's picture is taken. */
export type ShotOptions = { clip?: [number, number, number, number]; beyond?: boolean; fullPage?: boolean; pixelRatio: number };

/** The page and the Mac, as a capture reaches them. The live one is in captureEngine.ts. */
export class CaptureEngine extends Context.Service<
  CaptureEngine,
  {
    /** Whether the tab has a page to capture. */
    readonly hasPage: (tabId: string) => boolean;
    /** Runs a script in the page. */
    readonly evaluate: (tabId: string, script: string) => Effect.Effect<unknown, CaptureFailure>;
    /** Gives the page the keyboard. */
    readonly focus: (tabId: string) => Effect.Effect<void>;
    /** The page's pixels per CSS px: the screen's scale. */
    readonly screenScale: () => number;
    /** Takes the page's picture. Nothing, when the page did not paint in time. */
    readonly shoot: (tabId: string, options: ShotOptions) => Effect.Effect<CapturedImage | null, CaptureFailure>;
    /** The page as it is shown, as a PNG. */
    readonly screenshot: (tabId: string) => Effect.Effect<string | null, CaptureFailure>;
    /** Puts a PNG on the clipboard. */
    readonly copyPng: (png: string) => Effect.Effect<boolean, CaptureFailure>;
    /** Puts a picture on the clipboard. */
    readonly copy: (path: string) => Effect.Effect<boolean, CaptureFailure>;
    /** Saves a picture to Downloads, and says where it went. */
    readonly save: (path: string, name: string) => Effect.Effect<string | null, CaptureFailure>;
    /** Opens the share menu for a picture. */
    readonly share: (path: string, name: string, windowId: string | null, anchor?: [number, number, number, number]) => Effect.Effect<void, CaptureFailure>;
    /** Frames a picture on the space's colours. */
    readonly portrait: (path: string, colors: string[], dark: boolean) => Effect.Effect<CapturedImage | null, CaptureFailure>;
    /** Shows a file in Finder. */
    readonly reveal: (path: string) => void;
    /** The window the Library opens in, or nothing in a private window (which says so). */
    readonly libraryWindow: (windowId: string) => string | null;
    /** Lets the user put a picture on an Easel, and says whether they did. */
    readonly chooseEasel: (media: LibraryMedia, windowId: string) => Effect.Effect<boolean, CaptureFailure>;
  }
>()("bay/CaptureEngine") {}

// MARK: The service

/** A capture's job, and the generation it belongs to. */
type Job = { readonly generation: number; readonly fiber: Fiber.Fiber<void> };

const finite = (value: unknown): value is number => v.is(v.number(), value) && Number.isFinite(value);

const ICON = { icon: "camera.viewfinder" } as const;

export class CaptureService extends Context.Service<
  CaptureService,
  {
    /** Puts a capture away when its page goes: its tab closed, or another document loaded in it. */
    readonly start: Effect.Effect<void>;
    /** Capture on a tab's page: its selection, or with one up, takes it away. `start` begins with a drag. */
    readonly begin: (tabId: string, start?: { x: number; y: number }) => Effect.Effect<void>;
    /** Takes the capture away, and the selection in the page with it. */
    readonly cancel: (tabId: string) => Effect.Effect<void>;
    /** Puts the capture away, the page taking the keyboard back. */
    readonly close: (tabId: string) => Effect.Effect<void>;
    /** Takes the picture again. */
    readonly retake: (tabId: string) => Effect.Effect<void>;
    /** What the selection in a page sends: untrusted, as everything from a page. */
    readonly message: (tabId: string, data: JsonInput) => Effect.Effect<void>;
    /** ⌘⇧ pressed on the page: Capture, with a drag from there. */
    readonly gesture: (tabId: string, data: JsonInput) => Effect.Effect<void>;
    /** Copies the picture. */
    readonly copy: (tabId: string) => Effect.Effect<void>;
    /** Keeps the picture in the Library, or on an Easel. */
    readonly toLibrary: (tabId: string, toEasel: boolean) => Effect.Effect<void>;
    /** Saves the picture to Downloads. */
    readonly save: (tabId: string) => Effect.Effect<void>;
    /** The share menu for the picture. */
    readonly share: (tabId: string, anchor?: [number, number, number, number]) => Effect.Effect<void>;
    /** The whole page, top to bottom, saved to Downloads. */
    readonly fullPage: (tabId: string) => Effect.Effect<void>;
    /** The page as it is shown, framed on its space's colours: copied, and saved to Downloads and the Library. */
    readonly portrait: (tabId: string) => Effect.Effect<void>;
    /** The page as it is shown, on the clipboard: the developer's screenshot. */
    readonly screenshot: (tabId: string) => Effect.Effect<void>;
  }
>()("bay/CaptureService") {
  static readonly layer = Layer.effect(
    CaptureService,
    Effect.gen(function* () {
      const engine = yield* CaptureEngine;
      const library = yield* LibraryService;
      const diagnostics = yield* Diagnostics;
      const scope = yield* Scope.Scope;

      // A failure is reported where every other failure goes: the toast the user sees says what it means for them.
      const report = (failure: CaptureFailure): Effect.Effect<void> =>
        diagnostics.report({
          operation: failure.operation,
          message: failure.message,
          cause: failure.cause instanceof Error ? failure.cause : new Error(String(failure.cause)),
        });

      // A native step that failed is reported, and comes back as nothing: the job goes on as it did when the Mac
      // answered with nothing.
      const orNull = <A>(effect: Effect.Effect<A, CaptureFailure>): Effect.Effect<A | null> =>
        effect.pipe(Effect.catch((failure) => report(failure).pipe(Effect.as(null))));

      const tabOf = (tabId: string): Tab | undefined => useBrowser.getState().tabs[tabId];

      const windowOf = (tabId: string) => tabOf(tabId)?.windowId ?? null;

      // The page's pixels per CSS px: the screen's scale times the tab's zoom.
      const pixelRatioOf = (tabId: string) => engine.screenScale() * (tabOf(tabId)?.zoom ?? 1);

      // MARK: The capture's generation

      const generations = new Map<string, number>();
      const jobs = new Map<string, Job>();

      const generationOf = (tabId: string) => generations.get(tabId) ?? 0;

      // A new generation: whatever was running for the tab is no longer the capture it shows.
      const advance = (tabId: string): number => {
        const next = generationOf(tabId) + 1;

        generations.set(tabId, next);

        return next;
      };

      const current = (tabId: string, generation: number) => generationOf(tabId) === generation;

      // The job that was running stops: a stage that comes back after this finds nothing to do.
      const stopJob = (tabId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const job = jobs.get(tabId);

          if (!job) return;

          jobs.delete(tabId);

          yield* Fiber.interrupt(job.fiber);
        });

      // A job of the capture's: it runs in the app's scope, it is the tab's only one, and it lets go when it ends.
      const run = (tabId: string, generation: number, work: Effect.Effect<void>): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* stopJob(tabId);

          const fiber = yield* Effect.forkIn(
            work.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (jobs.get(tabId)?.generation === generation) jobs.delete(tabId);
                }),
              ),
            ),
            scope,
          );

          jobs.set(tabId, { generation, fiber });
        });

      // The selection is taken out of the page. It is asked for whatever the page shows: a page that never got it
      // has nothing to take out.
      const removeSelection = (tabId: string): Effect.Effect<void> =>
        engine.hasPage(tabId) ? orNull(engine.evaluate(tabId, captureScript(false))).pipe(Effect.asVoid) : Effect.void;

      // MARK: Selecting

      const cancel = (tabId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const selecting = sessionOf(tabId)?.phase === "selecting";

          advance(tabId);
          setSession(tabId, null);

          yield* stopJob(tabId);

          if (selecting) yield* removeSelection(tabId);
        });

      const close = (tabId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (!sessionOf(tabId)) return;

          yield* cancel(tabId);
          yield* engine.focus(tabId);
        });

      // A tab that can be captured: not one of the app's own pages, which aren't web pages.
      const capturable = (tabId: string): Tab | null => {
        const tab = tabOf(tabId);

        if (!tab?.url || !engine.hasPage(tabId)) return null;

        if (isInternalTab(tab)) {
          showToast(tab.windowId, "Can’t Capture This Page", "Capture works on web pages.", ICON);

          return null;
        }

        return tab;
      };

      const shoot = (tabId: string, generation: number, options: Omit<ShotOptions, "pixelRatio">, area: CaptureArea | null): Effect.Effect<void> =>
        Effect.gen(function* () {
          const tab = tabOf(tabId);

          if (!tab) return setSession(tabId, null);

          setSession(tabId, { phase: "shooting", url: tab.url });

          const image = yield* orNull(engine.shoot(tabId, { ...options, pixelRatio: pixelRatioOf(tabId) }));

          // Put away, or the page left, while it was taken.
          if (!current(tabId, generation) || sessionOf(tabId)?.phase !== "shooting") return;

          if (!image) {
            setSession(tabId, null);

            return showToast(tab.windowId, "Couldn’t Capture the Page", "The page didn’t paint in time.", ICON);
          }

          const now = tabOf(tabId) ?? tab;

          setSession(tabId, { phase: "ready", url: tab.url, image, area, name: captureName(now.customTitle || now.title, now.url, new Date()) });
        });

      const begin = (tabId: string, start?: { x: number; y: number }): Effect.Effect<void> =>
        Effect.gen(function* () {
          const session = sessionOf(tabId);

          if (session?.phase === "selecting" && !start) return yield* cancel(tabId);

          if (session?.phase === "shooting") return;

          const tab = capturable(tabId);

          if (!tab) return;

          const generation = advance(tabId);

          setSession(tabId, { phase: "selecting", url: tab.url });

          const selecting = Effect.gen(function* () {
            const installed = yield* orNull(engine.evaluate(tabId, captureScript(true, start)));

            if (!current(tabId, generation) || sessionOf(tabId)?.phase !== "selecting") return;

            // A page scripts can't run in (Chrome's own pages, a PDF): what it shows.
            if (installed !== true) return yield* shoot(tabId, generation, {}, null);

            yield* engine.focus(tabId);
          });

          yield* run(tabId, generation, selecting);
        });

      const retake = (tabId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          advance(tabId);
          setSession(tabId, null);

          yield* stopJob(tabId);
          yield* begin(tabId);
        });

      const message = (tabId: string, data: JsonInput): Effect.Effect<void> =>
        Effect.gen(function* () {
          const m = isJsonObject(data) ? data : null;

          if (!m || sessionOf(tabId)?.phase !== "selecting") return;

          const generation = generationOf(tabId);

          if (m.type === "cancel") {
            advance(tabId);

            return setSession(tabId, null);
          }

          if (m.type === "fullPage") {
            advance(tabId);
            setSession(tabId, null);

            return yield* m.portrait === true ? portrait(tabId) : fullPage(tabId);
          }

          if (m.type !== "capture") return;

          const { x, y, width, height, left, top, viewportWidth, viewportHeight } = m;

          if (
            !finite(x) ||
            !finite(y) ||
            !finite(width) ||
            !finite(height) ||
            !finite(left) ||
            !finite(top) ||
            !finite(viewportWidth) ||
            !finite(viewportHeight)
          ) {
            return setSession(tabId, null);
          }

          if (width < 1 || height < 1 || viewportWidth < 1) return setSession(tabId, null);

          const area: CaptureArea = { x, y, left, top, width, height, viewportWidth, viewportHeight };

          yield* run(tabId, generation, shoot(tabId, generation, { clip: [x, y, width, height], beyond: m.beyond === true }, area));
        });

      const gesture = (tabId: string, data: JsonInput): Effect.Effect<void> =>
        Effect.gen(function* () {
          const m = isJsonObject(data) ? data : null;

          if (!m || !finite(m.x) || !finite(m.y) || sessionOf(tabId)?.phase === "shooting") return;

          yield* begin(tabId, { x: m.x, y: m.y });
        });

      // MARK: The picture

      const savedToast = (windowId: string, path: string | null, title: string) => {
        if (!path) return showToast(windowId, "Couldn’t Save the Capture", "Bay couldn’t write to Downloads.", ICON);

        const file = path.split("/").pop() ?? path;

        showToast(windowId, title, `In Downloads as ${file}`, {
          icon: "arrow.down.circle",
          key: "capture",
          action: { title: "Show in Finder", run: () => engine.reveal(path) },
        });
      };

      const copy = (tabId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const session = readyOf(tabId);
          const windowId = windowOf(tabId);

          if (!session || !windowId) return;

          const copied = yield* orNull(engine.copy(session.image.path));

          yield* close(tabId);

          if (copied) showToast(windowId, "Copied Capture", undefined, { icon: "doc.on.doc" });
          else showToast(windowId, "Couldn’t Copy the Capture", undefined, ICON);
        });

      // The page the picture came from, for the Library: a web page only, and the part of it that was taken.
      const sourceOf = (url: string, tab: Tab, area: CaptureArea | null): CaptureSource | undefined =>
        webLink(url)
          ? {
              url,
              title: tab.customTitle || tab.title,
              profileId: engineProfile(tab.spaceId),
              ...(area
                ? {
                    clip: [area.x ?? area.left, area.y ?? area.top, area.width, area.height],
                    viewportWidth: area.viewportWidth,
                    viewportHeight: area.viewportHeight,
                  }
                : undefined),
            }
          : undefined;

      const toLibrary = (tabId: string, toEasel: boolean): Effect.Effect<void> =>
        Effect.gen(function* () {
          const session = readyOf(tabId);
          const tab = tabOf(tabId);

          if (!session || !tab || !engine.libraryWindow(tab.windowId)) return;

          // An explicit save keeps a copy outside Chromium's temporary capture cache.
          const media = yield* library
            .saveMedia(session.image, session.name, sourceOf(session.url, tab, session.area))
            .pipe(Effect.catch(() => Effect.succeed(null)));

          if (!media) return showToast(tab.windowId, "Couldn't Save Capture", "Bay couldn't save the image to Library.", ICON);

          if (!toEasel) {
            yield* close(tabId);

            return showToast(tab.windowId, "Saved to Library", undefined, { icon: "books.vertical" });
          }

          if (yield* orNull(engine.chooseEasel(media, tab.windowId))) yield* close(tabId);
        });

      const save = (tabId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const session = readyOf(tabId);
          const windowId = windowOf(tabId);

          if (!session || !windowId) return;

          const saved = yield* orNull(engine.save(session.image.path, session.name));

          yield* close(tabId);

          savedToast(windowId, saved, "Saved Capture");
        });

      const share = (tabId: string, anchor?: [number, number, number, number]): Effect.Effect<void> =>
        Effect.gen(function* () {
          const session = readyOf(tabId);

          if (session) yield* orNull(engine.share(session.image.path, session.name, windowOf(tabId), anchor));
        });

      const fullPage = (tabId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const tab = capturable(tabId);

          if (!tab) return;

          showToast(tab.windowId, "Capturing Full Page…", undefined, { ...ICON, key: "capture", sticky: true });

          const image = yield* orNull(engine.shoot(tabId, { fullPage: true, pixelRatio: pixelRatioOf(tabId) }));

          if (!image) return showToast(tab.windowId, "Couldn’t Capture the Page", "The page didn’t paint in time.", { ...ICON, key: "capture" });

          const now = tabOf(tabId) ?? tab;
          const saved = yield* orNull(engine.save(image.path, captureName(now.customTitle || now.title, now.url, new Date(), true)));

          savedToast(tab.windowId, saved, "Saved Full Page Capture");
        });

      const portrait = (tabId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const tab = capturable(tabId);

          if (!tab) return;

          showToast(tab.windowId, "Capturing in Portrait…", undefined, { ...ICON, key: "capture", sticky: true });

          const failed = () => showToast(tab.windowId, "Couldn’t Capture the Page", "The page didn’t paint in time.", { ...ICON, key: "capture" });

          // Portrait is at 2×, whatever the screen.
          const shot = yield* orNull(engine.shoot(tabId, { pixelRatio: 2 * (tab.zoom ?? 1) }));

          if (!shot) return failed();

          const s = useBrowser.getState();
          const theme = themeFor(themeKey(s, tab.windowId, tab.spaceId));
          const own = s.spaces[tab.spaceId]?.theme?.colors ?? [];
          const framed = yield* orNull(engine.portrait(shot.path, own.length ? own : [theme.accent, theme.windowTint[1]], theme.dark));

          if (!framed) return failed();

          const now = tabOf(tabId) ?? tab;
          const name = captureName(now.customTitle || now.title, now.url, new Date(), "portrait");

          yield* orNull(engine.copy(framed.path));

          // The Library keeps its copy alongside: a private window has no Library, and says so.
          if (engine.libraryWindow(tab.windowId))
            yield* Effect.forkIn(library.saveMedia(framed, name, sourceOf(now.url, now, null)).pipe(Effect.ignore), scope);

          const saved = yield* orNull(engine.save(framed.path, name));

          savedToast(tab.windowId, saved, "Copied Portrait Capture");
        });

      const screenshot = (tabId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const tab = tabOf(tabId);

          if (!tab) return;

          const png = yield* orNull(engine.screenshot(tabId));
          const copied = png ? yield* orNull(engine.copyPng(png)) : false;

          if (copied) showToast(tab.windowId, "Copied Screenshot", "The page as it's shown now.", { icon: "camera" });
          else showToast(tab.windowId, "Couldn’t Take a Screenshot", "The page didn’t paint in time.", { icon: "camera" });
        });

      // MARK: Starting

      let started = false;

      const start = Effect.gen(function* () {
        if (started) return;

        started = true;

        const page = (url: string) => url.replace(/#.*$/, "");

        const stop = useBrowser.subscribe((s, prev) => {
          if (s.tabs === prev.tabs) return;

          for (const [tabId, session] of Object.entries(useCaptures.getState().sessions)) {
            const url = s.tabs[tabId]?.url;

            if (url !== undefined && page(url) === page(session.url)) continue;

            // The tab closed: there is no page left to take the selection out of.
            if (url === undefined) {
              advance(tabId);
              setSession(tabId, null);
              void Effect.runFork(Effect.forkIn(stopJob(tabId), scope));

              continue;
            }

            // Another document loaded: the capture was of the page that left.
            void Effect.runFork(Effect.forkIn(cancel(tabId), scope));
          }
        });

        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            stop();
            started = false;
          }),
        );
      });

      return CaptureService.of({
        start,
        begin,
        cancel,
        close,
        retake,
        message,
        gesture,
        copy,
        toLibrary,
        save,
        share,
        fullPage,
        portrait,
        screenshot,
      });
    }),
  );
}

/** What capture can do. */
export type Capture = CaptureService["Service"];
