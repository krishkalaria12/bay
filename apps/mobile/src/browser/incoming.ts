// Links from other apps (B9, B14, B15): the URL Bay was launched with, links that arrive while it runs, and shares
// (an Android SEND intent on a running app, or one that launched Bay cold; iOS's extension opens `bay://share?url=…`,
// which arrives as a link). The three sources are registered once, on the app scope.
//
// A link that launched Bay waits for the saved tabs, so a cold start never opens over nothing; only the newest one
// waits. Once the tabs are loaded and the screen is listening, a link is handed over the moment it arrives. What a
// link means (a page, a share, a `bay://` command) is the screen's to read, with the pure parsers in `incomingLink`.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { BrowserState } from "../effect/ports/browserState.ts";
import { Diagnostics } from "../effect/ports/diagnostics.ts";
import { Links, type LinksError } from "../effect/ports/links.ts";

export class IncomingLinks extends Context.Service<
  IncomingLinks,
  {
    /** Registers the three sources and waits for the saved tabs. They stop when the scope closes. */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    /**
     * Hands each link to `receive` once the tabs are loaded, starting with the one that waited. It listens until it is
     * interrupted.
     */
    readonly receive: (receive: (url: string) => void) => Effect.Effect<never>;
  }
>()("bay/IncomingLinks") {
  static readonly layer = Layer.effect(
    IncomingLinks,
    Effect.gen(function* () {
      const links = yield* Links;
      const browserState = yield* BrowserState;
      const diagnostics = yield* Diagnostics;

      // The newest link nobody has taken yet, whether the tabs have loaded, and the screen listening for links.
      let waiting: string | null = null;
      let ready = false;
      let receiver: ((url: string) => void) | null = null;

      /** Hands the waiting link over when the tabs and the screen can both take it. */
      const handOver = (): void => {
        if (!ready || !receiver || waiting === null) return;

        const url = waiting;

        waiting = null;
        receiver(url);
      };

      const arrive = (url: string | null): void => {
        // No link is not a link: it never replaces one that is waiting.
        if (!url) return;

        waiting = url;
        handOver();
      };

      /** Reads a source once, reporting one that can't be read rather than failing the others. */
      const readOnce = (source: Effect.Effect<string | null, LinksError>, message: string) =>
        source.pipe(
          Effect.flatMap((url) => Effect.sync(() => arrive(url))),
          Effect.catch((error) => diagnostics.report({ operation: error.operation, message, cause: error })),
        );

      return IncomingLinks.of({
        start: Effect.gen(function* () {
          const scope = yield* Scope.Scope;

          yield* links.onLink(arrive);
          yield* links.onShare(arrive);

          yield* Effect.forkIn(readOnce(links.initial(), "The link Bay was opened with could not be read"), scope);
          yield* Effect.forkIn(readOnce(links.takeShare(), "The share Bay was opened with could not be read"), scope);
          yield* Effect.forkIn(
            browserState.awaitReady().pipe(
              Effect.flatMap(() =>
                Effect.sync(() => {
                  ready = true;
                  handOver();
                }),
              ),
              Effect.catch((error) => diagnostics.report({ operation: error.operation, message: "Incoming links could not wait for the tabs", cause: error })),
            ),
            scope,
          );
        }),
        receive: (receive) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              receiver = receive;
              handOver();
            }),
            () => Effect.never,
            () =>
              Effect.sync(() => {
                if (receiver === receive) receiver = null;
              }),
          ),
      });
    }),
  );
}
