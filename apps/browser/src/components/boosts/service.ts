// Boosts' own work: the count a page gives of the elements a Boost's zaps hide, and the document the Boosts are
// kept in.
//
// A count is a job: the page is asked how many elements each of a Boost's selectors matches, and the answer belongs
// to the editor generation that asked for it. An editor that closed gets no answer, and an answer that comes back
// late never reaches the editor that took its place.
//
// The document has one writer: this service. The store says what the Boosts are, and the service keeps the file in
// step with it, so the last change is the one that is on disk.
//
// The Boosts themselves stay plain (lib/boosts.ts): the rules that make one, the CSS it writes and the script the page
// runs are the same for every build. Only the two things that wait — the page's answer and the write — are here.
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { Operation } from "../../effect/errors";
import { Diagnostics } from "../../effect/ports/diagnostics";
import { Documents } from "../../effect/ports/documents";
import { BOOSTS_FILE, boostDocumentJson } from "../../lib/boosts";
import { webviews } from "../../lib/webviews";
import { countScript } from "./pickerScript";
import { useBoosts } from "./state";

// MARK: The port

/** The page could not be asked. */
export class BoostFailure extends TaggedError("BoostFailure")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** The page a tab is showing, as the Boost editor reaches it. */
export class BoostEngine extends Context.Service<
  BoostEngine,
  {
    /** Asks the page how many elements each selector matches; nothing when the page has no answer. */
    readonly counts: (tabId: string, selectors: readonly string[]) => Effect.Effect<number[] | null, BoostFailure>;
  }
>()("bay/BoostEngine") {
  static readonly layer = Layer.succeed(BoostEngine)({
    counts: (tabId, selectors) =>
      Effect.suspend(() => {
        const view = webviews.get(tabId);

        // The tab has no page: there is nobody to ask.
        if (!view) return Effect.succeed(null);

        return Effect.tryPromise({
          try: () => view.evaluate<number[]>(countScript([...selectors])),
          catch: (cause) => new BoostFailure({ operation: { name: "boost.counts", resource: tabId }, cause }),
        });
      }),
  });
}

// MARK: What the app asks for

/** The count an editor asks a page for. */
export type CountRequest = {
  /** The tab whose page is asked. */
  readonly tabId: string;
  /** The editor generation that asked: the answer belongs to it alone. */
  readonly generation: string;
  /** The selectors to count. */
  readonly selectors: readonly string[];
};

/** What came of the count. */
export type CountOutcome =
  /** The page answered, and the editor generation that asked is still the one waiting for it. */
  | { readonly kind: "counts"; readonly counts: Record<string, number> }
  /** The editor closed while the page was asked: its answer is not wanted. */
  | { readonly kind: "closed" }
  /** Another editor generation took over: the answer belongs to it, not to the one that asked. */
  | { readonly kind: "superseded" }
  /** The page could not be asked. */
  | { readonly kind: "failed" };

/** What came of writing the Boosts to their document. */
export type SaveOutcome =
  /** The Boosts are on disk, or there was nothing to write. */
  | { readonly kind: "saved" }
  /** The write failed: the Boosts are still owed, and the failure was reported. */
  | { readonly kind: "failed"; readonly message: string };

// MARK: The service

/** The count a tab is waiting for. */
type Pending = {
  /** The editor generation that asked: another one's answer is not this one's. */
  readonly generation: string;
  /** The request that is current: an older answer never replaces it. */
  readonly token: symbol;
  /** The editor closed while the page was asked. */
  closed: boolean;
};

export class BoostsService extends Context.Service<
  BoostsService,
  {
    /** Asks the page how many elements each selector hides. The answer belongs to the editor generation that asked. */
    readonly counts: (request: CountRequest) => Effect.Effect<CountOutcome>;
    /** Gives up a count: the editor closed, or another one took its place. */
    readonly abandon: (tabId: string, generation: string) => Effect.Effect<void>;
    /** Writes the Boosts to the document that holds them. */
    readonly save: Effect.Effect<SaveOutcome>;
  }
>()("bay/BoostsService") {
  static readonly layer = Layer.effect(
    BoostsService,
    Effect.gen(function* () {
      const engine = yield* BoostEngine;
      const documents = yield* Documents;
      const diagnostics = yield* Diagnostics;
      const scope = yield* Scope.Scope;

      // The count each tab is waiting for.
      const pending = new Map<string, Pending>();

      // The document as it is on disk. It is null while the store has not been read: the file is not known to hold
      // what the store holds.
      let written: string | null = null;
      const loaded = useBoosts.getState();

      if (loaded.loaded && !loaded.error) written = boostDocumentJson(loaded);

      // The document is written now: the Boosts are on disk before the change is done, as they always were.
      const writeDocument: Effect.Effect<SaveOutcome> = Effect.gen(function* () {
        const state = useBoosts.getState();

        // The file has not been read yet, or it could not be read: it is kept as it is.
        if (!state.loaded || state.error) return yield* Effect.succeed({ kind: "saved" } as const);

        const json = boostDocumentJson(state);

        // Nothing has changed since the last write.
        if (written !== null && json === written) return yield* Effect.succeed({ kind: "saved" } as const);

        const outcome = yield* Effect.exit(documents.write(BOOSTS_FILE, json));

        if (Exit.isFailure(outcome)) {
          const squashed = Cause.squash(outcome.cause);
          const error = squashed instanceof Error ? squashed : new Error(String(squashed));

          // The write failed: the Boosts are still owed, and the failure is reported once.
          yield* diagnostics.report({ operation: { name: "boosts.save", resource: BOOSTS_FILE }, message: "The Boosts could not be saved.", cause: error });

          return yield* Effect.succeed({ kind: "failed", message: error.message } as const);
        }

        written = json;

        return yield* Effect.succeed({ kind: "saved" } as const);
      });

      const counts = (request: CountRequest): Effect.Effect<CountOutcome> =>
        Effect.gen(function* () {
          const token = Symbol();

          // The count that is current for this tab: an older answer never replaces it.
          pending.set(request.tabId, { generation: request.generation, token, closed: false });

          // A Boost with no zaps hides nothing: there is nothing to ask the page.
          if (!request.selectors.length) {
            pending.delete(request.tabId);

            return yield* Effect.succeed({ kind: "counts", counts: {} } as const);
          }

          const answer = yield* engine.counts(request.tabId, request.selectors).pipe(Effect.catch(() => Effect.succeed(null)));
          const current = pending.get(request.tabId);

          // Another count took over while the page was asked.
          if (!current || current.token !== token) return yield* Effect.succeed({ kind: "superseded" } as const);

          pending.delete(request.tabId);

          // The editor that asked closed while the page was asked.
          if (current.closed) return yield* Effect.succeed({ kind: "closed" } as const);

          // The page had no answer: a count is an enrichment, and the editor shows none.
          if (!answer || !Array.isArray(answer)) return yield* Effect.succeed({ kind: "failed" } as const);

          const counts: Record<string, number> = {};

          request.selectors.forEach((selector, i) => (counts[selector] = Number(answer[i]) || 0));

          return yield* Effect.succeed({ kind: "counts", counts } as const);
        });

      // The editor that asked is gone: its answer is not wanted any more.
      const abandon = (tabId: string, generation: string): Effect.Effect<void> =>
        Effect.sync(() => {
          const current = pending.get(tabId);

          // Another editor generation is waiting for this tab: its answer is not this one's to give up.
          if (!current || current.generation !== generation) return;

          current.closed = true;
        });

      // The store is the app's: the service keeps the document in step with it, and lets go of the subscription
      // when its scope closes.
      const unsubscribe = useBoosts.subscribe(() => {
        void Effect.runSyncExit(writeDocument);
      });

      yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));

      return BoostsService.of({ counts, abandon, save: writeDocument });
    }),
  );
}

/** What the Boosts service can do. */
export type Boosts = BoostsService["Service"];
