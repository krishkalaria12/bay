// The app's authority store: the state the coordinator owns and the workflows write to.
//
// The store is a port, not the imported singleton. The coordinator builds one runtime per authority and gives it
// the store that authority owns, so two authorities can exist in one process without sharing state. The macOS host
// has one authority and passes the app's own store; a test passes a store of its own.
//
// The store package stays free of Effect: this file is the door into it, and it is reached only from a workflow.
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { BrowserState, BrowserStore } from "../../store/browserStore";

export class AuthorityStore extends Context.Service<
  AuthorityStore,
  {
    readonly store: BrowserStore;
    /** The state as it is now. */
    readonly getState: () => BrowserState;
    /** Replaces part of the state, or all of it. */
    readonly setState: (partial: Partial<BrowserState> | ((state: BrowserState) => Partial<BrowserState>)) => void;
    /** Watches the state. The returned function stops watching. */
    readonly subscribe: (listener: (state: BrowserState, previous: BrowserState) => void) => () => void;
  }
>()("bay/AuthorityStore") {
  /** The layer for one store: the authority the runtime's workflows write to. */
  static readonly layer = (store: BrowserStore): Layer.Layer<AuthorityStore> =>
    Layer.succeed(AuthorityStore)({
      store,
      getState: () => store.getState(),
      setState: (partial) => store.setState(partial),
      subscribe: (listener) => store.subscribe(listener),
    });
}
