import { useSyncExternalStore } from "react";
import { useBrowser, type BrowserStore } from "./browser";
import { createBrowserProjector, type BrowserProjection } from "../runtime/projection";
import type { createBrowserClient } from "../runtime/client";

export type BrowserReadSource = {
  getState(): BrowserProjection;
  subscribe(listener: () => void): () => void;
};

export function createLocalBrowserReadSource(store: BrowserStore): BrowserReadSource {
  const project = createBrowserProjector();
  let previous: ReturnType<BrowserStore["getState"]> | undefined;
  let snapshot: BrowserProjection;
  return {
    getState() {
      const state = store.getState();
      if (state !== previous) { snapshot = project(state); previous = state; }
      return snapshot;
    },
    subscribe: listener => store.subscribe(listener),
  };
}

export function createClientBrowserReadSource(client: Pick<ReturnType<typeof createBrowserClient>, "getSnapshot" | "getStatus" | "subscribe">): BrowserReadSource {
  return {
    getState() {
      const snapshot = client.getSnapshot();
      if (!snapshot || client.getStatus() === "closed") throw new Error("The browser runtime is not available");
      return snapshot.state;
    },
    subscribe: client.subscribe,
  };
}

/** A read-only source switch. Remote installation never changes the legacy
 * writable singleton used by UI that has not yet migrated.
 */
export function createBrowserReader(initial: BrowserReadSource) {
  const bindings = [{ source: initial }];
  let source = initial;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  let unsubscribe: (() => void) | undefined;
  const connect = () => { unsubscribe?.(); unsubscribe = listeners.size ? source.subscribe(notify) : undefined; };
  return {
    getState: () => source.getState(),
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) connect();
      return () => { listeners.delete(listener); if (!listeners.size) { unsubscribe?.(); unsubscribe = undefined; } };
    },
    install(next: BrowserReadSource) {
      next.getState(); // A visible window must have a complete snapshot first.
      const binding = { source: next };
      bindings.push(binding);
      source = next;
      connect();
      notify();
      return () => {
        const index = bindings.indexOf(binding);
        if (index < 0) return;
        const current = index === bindings.length - 1;
        bindings.splice(index, 1);
        if (current) { source = bindings[bindings.length - 1]!.source; connect(); notify(); }
      };
    },
  };
}

export const browserRead = createBrowserReader(createLocalBrowserReadSource(useBrowser));
export const installBrowserReadSource = browserRead.install;
export function useBrowserRead<T>(select: (state: BrowserProjection) => T): T {
  return useSyncExternalStore(browserRead.subscribe, () => select(browserRead.getState()), () => select(browserRead.getState()));
}
