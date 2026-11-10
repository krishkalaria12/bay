// The app's saving. The coordinator owns the store subscription and the coalescing timer; the writes themselves
// stay immediate, because the quit handshake has to finish before the process goes. A write that fails stays
// dirty, so the next save tries it again.
//
// The coordinator is one per JavaScript instance: the quit handshake reaches it synchronously, and the runtime's
// service owns its lifetime.
import { writeDocument } from "@bay/desktop";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { startLiveFolders } from "../activity/activityStore";
import { startBoosts } from "../components/boosts/state";
import { startLibrary } from "../components/library/state";
import { useBrowser, type BrowserState } from "../store/browserStore";
import { SAVE_DELAY_MS } from "./constants";
import { startFavicons } from "./favicons";
import { DOCS, forgetClosedIncognito, loadSession, sessionNeedsRewrite, type Doc } from "./persist";

/** The app's saving, as the quit handshake and the runtime reach it. */
export type PersistenceCoordinator = {
  /** Loads the saved session into the store. The app's first window shows what was saved. */
  readonly hydrate: () => void;
  /** Starts saving: the store subscription and the coalescing timer. Gives back the stop. */
  readonly start: () => () => void;
  /** Writes every document that changed, now. */
  readonly flush: (options?: { final?: boolean }) => void;
  /** The quit was cancelled: saving goes on, starting with what changed meanwhile. */
  readonly resume: () => void;
};

const createCoordinator = (): PersistenceCoordinator => {
  // What the saving remembers between changes: the last source values it compared, the last contents it wrote, and
  // the documents it still owes. A stopped coordinator forgets them, so a fresh start begins from the saved session.
  let lastSources = new Map<string, unknown[]>();
  let lastJson = new Map<string, string>();
  let dirty = new Set<Doc>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // From the quit's last save until the quit ends or is cancelled: what the quit itself does to the store (its
  // windows closing) is never saved.
  let frozen = false;
  let stop: (() => void) | undefined;
  let hydrated = false;

  const write = (name: string, json: string) => {
    try {
      writeDocument(name, json);

      return true;
    } catch (error) {
      console.warn(`Couldn't save ${name}`, error);

      return false;
    }
  };

  const save = () => {
    clearTimeout(timer);
    timer = undefined;

    if (frozen) return;

    const s = useBrowser.getState();

    for (const doc of DOCS) {
      if (!dirty.has(doc)) continue;

      const json = doc.json(s);

      if (lastJson.get(doc.name) === json) {
        dirty.delete(doc);
        continue;
      }

      // A write that fails stays dirty: the next save tries it again.
      if (!write(doc.name, json)) continue;

      lastJson.set(doc.name, json);
      dirty.delete(doc);
    }
  };

  const check = (s: BrowserState, initial = false) => {
    if (frozen) return;

    for (const doc of DOCS) {
      const sources = doc.sources(s);
      const prev = lastSources.get(doc.name);

      if (prev && sources.every((v, i) => v === prev[i])) continue;
      lastSources.set(doc.name, sources);

      if (!initial) dirty.add(doc);
    }

    if (dirty.size && !timer) timer = setTimeout(save, SAVE_DELAY_MS);
  };

  const hydrate = () => {
    if (hydrated) return;
    hydrated = true;

    const session = loadSession();

    useBrowser.getState().hydrate(session ?? {});
    startLibrary();
    startBoosts();

    // What the store holds now is the baseline: a change after this is a change to save.
    check(useBrowser.getState(), true);

    // The saved spaces were isolated: the session is written again before anything else.
    if (sessionNeedsRewrite(session)) {
      dirty.add(DOCS.find((doc) => doc.name === "session.json")!);
      save();
    }
  };

  const start = () => {
    if (stop) return stop;

    // The saved session is loaded before the first window: the saving starts on what was loaded.
    hydrate();
    check(useBrowser.getState());

    const stops = [startFavicons(), startLiveFolders()];

    const stopSession = useBrowser.subscribe((s, prev) => {
      check(s);

      if (s.windows !== prev.windows) forgetClosedIncognito(s, prev);
    });

    stop = () => {
      stopSession();

      for (const one of stops) one();
      clearTimeout(timer);
      timer = undefined;
      stop = undefined;
      // A stopped coordinator forgets what it knew: a fresh start loads the saved session again.
      lastSources = new Map();
      lastJson = new Map();
      dirty = new Set();
      hydrated = false;
    };

    return stop;
  };

  return {
    hydrate,
    start,
    flush: (options) => {
      save();

      if (options?.final) frozen = true;
    },
    resume: () => {
      frozen = false;
      check(useBrowser.getState());
      save();
    },
  };
};

const coordinator = createCoordinator();

/** Starts the app's saving: the saved session is loaded, and every change from now on is written. */
export const startPersistence = (): (() => void) => {
  coordinator.hydrate();

  return coordinator.start();
};

/** Writes every document that changed, now. The quit handshake needs it before the process goes. */
export const flushPersistence = (options?: { final?: boolean }) => coordinator.flush(options);

/** The quit was cancelled: saving goes on, starting with what changed meanwhile. */
export const resumePersistence = () => coordinator.resume();

export class Persistence extends Context.Service<
  Persistence,
  {
    /** Starts the app's saving in the app's scope, and gives it back when the scope closes. */
    readonly start: Effect.Effect<void>;
  }
>()("bay/Persistence") {
  static readonly layer = Layer.effect(
    Persistence,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;

      return Persistence.of({
        start: Effect.suspend(() => {
          const stop = coordinator.start();

          // The app's scope owns the saving: it stops when the scope closes.
          return Scope.addFinalizer(scope, Effect.sync(stop));
        }),
      });
    }),
  );
}
