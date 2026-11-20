// Where a link really goes: its redirects are followed without opening it, for the link menu. The work belongs to the
// menu that asked, so closing the menu aborts the request; the whole answer has ten seconds.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Http } from "../effect/ports/http.ts";

/** How long the whole answer may take. */
export const RESOLVE_TIMEOUT = 10_000;

// Browsers give up after about 20; a link menu needs far fewer to say where a link goes.
export const MAX_REDIRECTS = 10;

/** How far a hop-by-hop walk got: the last hop it reached, or null before it reached any. */
type Progress = { current: string | null };

/** The address a Location header points at from `from`, or null when it isn't one. */
function nextHop(location: string, from: string): string | null {
  try {
    return new URL(location, from).href;
  } catch {
    return null;
  }
}

export class LinkResolver extends Context.Service<
  LinkResolver,
  {
    /** The address a link's redirects end at, or null when the link can't be reached. */
    readonly resolve: (url: string) => Effect.Effect<string | null>;
  }
>()("bay/LinkResolver") {
  static readonly layer = Layer.effect(
    LinkResolver,
    Effect.gen(function* () {
      const http = yield* Http;

      /** Follows the redirects in one request. A server that refuses HEAD is asked with GET. */
      const follow = (url: string) =>
        Effect.gen(function* () {
          const response = yield* http.probe({ url, method: "HEAD" });

          if (response.status !== 405 && response.status !== 501) return response.url || url;

          const retried = yield* http.probe({ url });

          return retried.url || url;
        });

      /**
       * The last address a link's redirects reach, read hop by hop; null when the link itself can't be reached. Each
       * hop it gets past is kept in `reached`, so a walk that runs out of time still says how far it got.
       */
      const lastHop = (url: string, reached: Progress) =>
        Effect.gen(function* () {
          let current = url;

          for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
            const answer = yield* Effect.result(http.probe({ url: current, method: "HEAD", redirect: "manual" }));

            // The hop that can't be loaded is where the link goes.
            if (answer._tag === "Failure") return hop === 0 ? null : current;

            const { status, headers } = answer.success;
            const location = status >= 300 && status < 400 ? headers.get("location") : null;

            if (!location) return current;

            // A relative Location resolves against the hop that sent it; an absolute one stays as it is. One that
            // isn't an address at all ends the walk where it is.
            const next = nextHop(location, current);

            if (!next) return current;

            current = next;
            reached.current = current;
          }

          return current;
        });

      return LinkResolver.of({
        resolve: (url) =>
          Effect.suspend(() => {
            const reached: Progress = { current: null };

            return follow(url).pipe(
              // iOS's App Transport Security refuses a plain-http hop, and the whole request fails with it
              // (iana.org/domains/example redirects to http://www.iana.org/…). Walk the redirects one at a time instead.
              Effect.catch(() => lastHop(url, reached)),
              Effect.timeoutOrElse({ duration: RESOLVE_TIMEOUT, orElse: () => Effect.succeed(reached.current) }),
            );
          }),
      });
    }),
  );
}
