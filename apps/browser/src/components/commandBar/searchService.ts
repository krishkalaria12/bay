// The command bar's search work: the engine's suggestions and the currency rates behind them.
//
// A suggestion is a job: the query changes while the request is out, so an answer belongs to the query that asked for
// it, and the palette closing takes the work with it. The debounce and the cache stay where they have always been —
// in the shared fetcher, which the desktop and the phone both use — and the service owns the generations and the
// lifetime around it.
import {
  createCurrencyConverter,
  createSuggestFetcher,
  MAX_BANG_LIST_CHARS,
  type CurrencyAnswer,
  type FetchLike,
  type SearchEngine,
  type SuggestFetcher,
} from "@bay/core";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { Operation } from "../../effect/errors";

// MARK: The network

/** The search engine could not be reached. */
export class SearchFailure extends TaggedError("SearchFailure")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** What the network said: the payload, and whether the server answered with a success. */
export type SearchPayload = {
  /** The status the server answered with. */
  readonly status: number;
  readonly ok: boolean;
  readonly body: string;
  /** The answer's headers, as the caller reads them. */
  readonly headers: { readonly get: (name: string) => string | null };
};

/** A signal that is cancelled when either of the two is. */
const link = (outer: AbortSignal, inner: AbortSignal): AbortSignal => {
  if (outer.aborted) return AbortSignal.abort();

  const controller = new AbortController();
  const cancel = () => controller.abort();

  outer.addEventListener("abort", cancel, { once: true });
  inner.addEventListener("abort", cancel, { once: true });

  return controller.signal;
};

/** The headers one request carries. */
export type SearchHeaders = { readonly [name: string]: string };

/** How a request goes out: the headers it carries, and whether it carries the user's cookies. */
export type SearchRequest = {
  readonly headers?: SearchHeaders;
  readonly credentials?: "omit" | "include" | "same-origin";
};

/** The network, as the search work reaches it. */
export class SearchNetwork extends Context.Service<
  SearchNetwork,
  {
    /** Reads the payload at `url`. The caller's signal stops the request when the work is cancelled. */
    readonly fetch: (url: string, signal: AbortSignal, request?: SearchRequest) => Effect.Effect<SearchPayload, SearchFailure>;
  }
>()("bay/SearchNetwork") {
  static readonly layer = Layer.succeed(SearchNetwork)({
    fetch: (url, signal, request) =>
      Effect.tryPromise({
        try: (effectSignal) => {
          const init: RequestInit = { signal: link(signal, effectSignal) };

          if (request?.headers) init.headers = request.headers;

          if (request?.credentials) init.credentials = request.credentials;

          return fetch(url, init).then(async (response) => ({
            status: response.status,
            ok: response.ok,
            body: await response.text(),
            headers: { get: (name: string) => response.headers.get(name) },
          }));
        },
        catch: (cause) => new SearchFailure({ operation: { name: "search.fetch", resource: url }, cause }),
      }),
  });
}

// MARK: The requests

/** Whether a query may be asked of the search engine. */
export type SearchPolicy =
  /** The engine may be asked. */
  | "ask"
  /** The search is turned off: nothing typed leaves the machine. */
  | "off"
  /** The query is private: it may not leave the machine. */
  | "private";

/** A suggestion the command bar asked for. */
export type SuggestRequest = {
  /** The engine to ask. */
  readonly engine: SearchEngine;
  /** The query, as it was typed. */
  readonly query: string;
  /** Whether the engine may be asked at all. */
  readonly policy: SearchPolicy;
  /** Where the answer goes, when it is still the one the field is waiting for. */
  readonly onResult: (suggestions: string[]) => void;
};

/** A currency the command bar asked for. */
export type ConvertRequest = {
  /** The expression, as it was typed. */
  readonly expression: string;
  /** Whether the rates may be asked for at all. */
  readonly policy: SearchPolicy;
  /** Where the answer goes, when it is still the one the field is waiting for. */
  readonly onResult: (answer: CurrencyAnswer | null) => void;
};

// MARK: The service

/** Where the bang list comes from, and what may be asked of it. */
const BANG_LIST_URL = "https://services.helium.imput.net/bangs.json";

/** How long the bang list may take. */
const BANG_LIST_TIMEOUT_MS = 10_000;

/** What the bang list's answer was. */
export type BangListReply = {
  /** The status the server answered with. */
  readonly status: number;
  /** The list itself, when the server sent one. */
  readonly body: string | null;
  /** What the list says it is. */
  readonly contentType: string | null;
  /** The version the list has, for the next ask. */
  readonly etag: string | null;
};

/** One command bar's search work: its own fetcher, its own rates, and the requests that are current. */
type Session = {
  /** The suggestions' debounce and cache: the shared fetcher owns both. */
  readonly fetcher: SuggestFetcher;
  /** The currency rates, and the cache of the rates that were read. */
  readonly rates: (raw: string) => Promise<CurrencyAnswer | null>;
  /** The suggestion request that is current: an older answer never replaces it. */
  suggestions: number;
  /** The currency request that is current: an older answer never replaces it. */
  currency: number;
  /** The fiber waiting for the suggestions. */
  suggestionsFiber: Fiber.Fiber<void> | undefined;
  /** The fiber waiting for the currency answer. */
  currencyFiber: Fiber.Fiber<void> | undefined;
};

export class SearchService extends Context.Service<
  SearchService,
  {
    /** Asks the engine for suggestions. The answer goes to the request that asked for it, and to no other. */
    readonly suggest: (session: string, request: SuggestRequest) => Effect.Effect<void>;
    /** Asks for a currency answer. The answer goes to the request that asked for it, and to no other. */
    readonly convert: (session: string, request: ConvertRequest) => Effect.Effect<void>;
    /** Stops the session's suggestions: the answer in flight is not the one the field is waiting for. */
    readonly stopSuggestions: (session: string) => Effect.Effect<void>;
    /** Stops the session's currency lookup: the answer in flight is not the one the field is waiting for. */
    readonly stopConversion: (session: string) => Effect.Effect<void>;
    /** Stops everything the session has and lets it go: the palette closed. */
    readonly close: (session: string) => Effect.Effect<void>;
    /** Asks for the bang list. The list is the app's one network for it: there is no second fetch. */
    readonly bangList: (etag: string | null) => Effect.Effect<BangListReply, SearchFailure>;
  }
>()("bay/SearchService") {
  static readonly layer = Layer.effect(
    SearchService,
    Effect.gen(function* () {
      const network = yield* SearchNetwork;
      const scope = yield* Scope.Scope;

      // The shared fetcher asks for a promise; the network speaks in effects. The bridge keeps the fetcher's own abort
      // signal, so a request that is cancelled stops at the network.
      const fetchLike: FetchLike = (url, init) =>
        new Promise((resolve, reject) => {
          void Effect.runPromiseExit(network.fetch(url, init.signal)).then((exit) => {
            if (Exit.isSuccess(exit)) {
              const payload = exit.value;

              resolve({ ok: payload.ok, text: () => Promise.resolve(payload.body) });

              return;
            }

            reject(Cause.squash(exit.cause));
          });
        });

      // The command bars that have work in flight, by their id.
      const sessions = new Map<string, Session>();

      const sessionOf = (id: string): Session => {
        const existing = sessions.get(id);

        if (existing) return existing;

        const created: Session = {
          fetcher: createSuggestFetcher({ fetch: fetchLike }),
          rates: createCurrencyConverter({ fetch: fetchLike }),
          suggestions: 0,
          currency: 0,
          suggestionsFiber: undefined,
          currencyFiber: undefined,
        };

        sessions.set(id, created);

        return created;
      };

      // The suggestions for the query, when they are still the ones the field is waiting for.
      const waitForSuggestions = (state: Session, request: SuggestRequest, mine: number): Effect.Effect<void> =>
        Effect.callback<void>((resume) => {
          state.fetcher.request(request.engine, request.query, (suggestions) => {
            // An answer belongs to the request that asked for it: a newer query's answer replaces it.
            if (state.suggestions !== mine) return;

            request.onResult(suggestions);
            resume(Effect.void);
          });

          // The work stops here: the request in flight is aborted, and a late answer is not the one the field waits for.
          return Effect.sync(() => {
            if (state.suggestions !== mine) return;

            state.suggestions++;
            state.fetcher.cancel();
          });
        });

      // The currency answer for the expression, when it is still the one the field is waiting for.
      const waitForConversion = (state: Session, request: ConvertRequest, mine: number): Effect.Effect<void> =>
        Effect.callback<void>((resume) => {
          void state.rates(request.expression).then(
            (answer) => {
              // An answer belongs to the request that asked for it: a newer expression's answer replaces it.
              if (state.currency === mine) request.onResult(answer);
              resume(Effect.void);
            },
            () => resume(Effect.void),
          );

          // The work stops here: a late answer is not the one the field waits for.
          return Effect.sync(() => {
            if (state.currency === mine) state.currency++;
          });
        });

      const stopSuggestions = (id: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const state = sessions.get(id);

          if (!state) return;

          // The answer in flight is not the one the field is waiting for any more.
          state.suggestions++;
          state.fetcher.cancel();

          const waiting = state.suggestionsFiber;

          state.suggestionsFiber = undefined;

          if (waiting) yield* Fiber.interrupt(waiting);
        });

      const stopConversion = (id: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const state = sessions.get(id);

          if (!state) return;

          // The answer in flight is not the one the field is waiting for any more.
          state.currency++;

          const waiting = state.currencyFiber;

          state.currencyFiber = undefined;

          if (waiting) yield* Fiber.interrupt(waiting);
        });

      const suggest = (id: string, request: SuggestRequest): Effect.Effect<void> =>
        Effect.gen(function* () {
          // A query that may not be asked takes the work in flight with it.
          if (request.policy !== "ask") {
            yield* stopSuggestions(id);

            return;
          }

          const state = sessionOf(id);

          // The request that is current: an older answer never replaces it.
          state.suggestions++;
          const mine = state.suggestions;

          // The previous request stops: its answer is not the one the field is waiting for.
          const previous = state.suggestionsFiber;

          state.suggestionsFiber = undefined;

          if (previous) yield* Fiber.interrupt(previous);

          state.suggestionsFiber = yield* Effect.forkIn(waitForSuggestions(state, request, mine), scope);
        });

      const convert = (id: string, request: ConvertRequest): Effect.Effect<void> =>
        Effect.gen(function* () {
          // A query that may not be asked takes the work in flight with it.
          if (request.policy !== "ask") {
            yield* stopConversion(id);

            return;
          }

          const state = sessionOf(id);

          // The request that is current: an older answer never replaces it.
          state.currency++;
          const mine = state.currency;

          // The previous request stops: its answer is not the one the field is waiting for.
          const previous = state.currencyFiber;

          state.currencyFiber = undefined;

          if (previous) yield* Fiber.interrupt(previous);

          state.currencyFiber = yield* Effect.forkIn(waitForConversion(state, request, mine), scope);
        });

      const close = (id: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const state = sessions.get(id);

          if (!state) return;

          sessions.delete(id);

          // Nothing that is in flight may answer a palette that has closed.
          state.suggestions++;
          state.currency++;
          state.fetcher.cancel();

          const suggestions = state.suggestionsFiber;
          const conversion = state.currencyFiber;

          state.suggestionsFiber = undefined;
          state.currencyFiber = undefined;

          if (suggestions) yield* Fiber.interrupt(suggestions);

          if (conversion) yield* Fiber.interrupt(conversion);
        });

      // The bang list: the app's own network for it, with the same timeout and the same size guard as before.
      const bangList = (etag: string | null): Effect.Effect<BangListReply, SearchFailure> =>
        Effect.gen(function* () {
          const headers = { Accept: "application/json" };

          if (etag) Object.assign(headers, { "If-None-Match": etag });

          const controller = new AbortController();

          const answer = yield* network.fetch(BANG_LIST_URL, controller.signal, { headers, credentials: "omit" }).pipe(
            Effect.timeout(Duration.millis(BANG_LIST_TIMEOUT_MS)),
            // A list that takes too long is a failure like any other: the app keeps the one it has.
            Effect.catch((cause) =>
              Effect.fail(
                new SearchFailure({
                  operation: { name: "search.bangList", resource: BANG_LIST_URL },
                  cause,
                }),
              ),
            ),
          );

          // A list that says it is too big is not read: the app keeps the one it has.
          const length = Number(answer.headers.get("content-length") ?? 0);

          if (length > MAX_BANG_LIST_CHARS) {
            return yield* Effect.fail(
              new SearchFailure({ operation: { name: "search.bangList", resource: BANG_LIST_URL }, cause: new Error("The bang list is too large") }),
            );
          }

          const body = answer.status === 200 ? answer.body : null;

          if (body && body.length > MAX_BANG_LIST_CHARS) {
            return yield* Effect.fail(
              new SearchFailure({ operation: { name: "search.bangList", resource: BANG_LIST_URL }, cause: new Error("The bang list is too large") }),
            );
          }

          return {
            status: answer.status,
            body,
            contentType: answer.headers.get("content-type"),
            etag: answer.headers.get("etag"),
          } satisfies BangListReply;
        });

      return SearchService.of({ suggest, convert, stopSuggestions, stopConversion, close, bangList });
    }),
  );
}

/** What the search service can do. */
export type Search = SearchService["Service"];
