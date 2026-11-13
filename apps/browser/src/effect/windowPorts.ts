// View workflows read the installed window projection. They never receive the writable authority store.
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { BrowserProjection } from "../runtime/projection";

export type WindowReadSource = {
  readonly getState: () => BrowserProjection;
  readonly subscribe: (listener: () => void) => () => void;
};

export class ReadBrowser extends Context.Service<
  ReadBrowser,
  {
    readonly getState: () => BrowserProjection;
    readonly subscribe: (listener: (state: BrowserProjection, previous: BrowserProjection) => void) => () => void;
  }
>()("bay/ReadBrowser") {
  static readonly layer = (source: WindowReadSource): Layer.Layer<ReadBrowser> =>
    Layer.succeed(ReadBrowser)({
      getState: source.getState,
      subscribe(listener) {
        let previous = source.getState();

        return source.subscribe(() => {
          const current = source.getState();

          if (current === previous) return;
          const before = previous;
          previous = current;
          listener(current, before);
        });
      },
    });
}
