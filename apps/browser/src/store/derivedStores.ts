import type { StoreApi } from "zustand/vanilla";
import { useBrowser, type BrowserShape } from "./browserStore";
import { changedIds } from "./recordDiff";
import { spaceHeaderHidden } from "./model";

type ReadStore<T> = Pick<StoreApi<T>, "getState" | "getInitialState" | "subscribe">;

/** A read-only field of the source store. Snapshots always come from the source, with no second copy to synchronize. */
export function selectStore<S, T>(source: ReadStore<S>, select: (state: S) => T): ReadStore<T> {
  const listeners = new Set<(state: T, prev: T) => void>();
  let stop: (() => void) | undefined;
  return {
    getState: () => select(source.getState()),
    getInitialState: () => select(source.getInitialState()),
    subscribe(listener) {
      const run = (state: T, prev: T) => listener(state, prev);
      listeners.add(run);
      stop ??= source.subscribe((s, prev) => {
        const before = select(prev);
        if (!Object.is(select(s), before)) listeners.forEach((notify) => notify(select(source.getState()), before));
      });
      return () => {
        listeners.delete(run);
        if (!listeners.size) {
          stop?.();
          stop = undefined;
        }
      };
    },
  };
}

/** One source subscription routes a record's changes to the IDs with mounted consumers. */
export function recordStores<S, T>(source: ReadStore<S>, select: (state: S) => Record<string, T>) {
  const listeners = new Map<string, Set<(state: T | undefined, prev: T | undefined) => void>>();
  let stop: (() => void) | undefined;
  return (id: string): ReadStore<T | undefined> => ({
    getState: () => select(source.getState())[id],
    getInitialState: () => select(source.getInitialState())[id],
    subscribe(listener) {
      let subscribers = listeners.get(id);
      if (!subscribers) listeners.set(id, (subscribers = new Set()));
      // Give each subscription its own identity, including two consumers that pass the same callback.
      const run = (state: T | undefined, prev: T | undefined) => listener(state, prev);
      subscribers.add(run);
      stop ??= source.subscribe((s, prev) => {
        const before = select(prev);
        for (const key of changedIds(select(s), before)) {
          listeners.get(key)?.forEach((notify) => notify(select(source.getState())[key], before[key]));
        }
      });
      return () => {
        if (!subscribers.delete(run)) return;
        if (!subscribers.size) listeners.delete(id);
        if (!listeners.size) {
          stop?.();
          stop = undefined;
        }
      };
    },
  });
}

export const tabStore = recordStores(useBrowser, (s) => s.tabs);
export const tabLiveStore = recordStores(useBrowser, (s) => s.live);
export const windowStore = recordStores(useBrowser, (s) => s.windows);
export const windowUiStore = recordStores(useBrowser, (s) => s.windowUi);
export const findStore = recordStores(useBrowser, (s) => s.find);
export const splitStore = recordStores(useBrowser, (s) => s.splits);
export const selectionStore = recordStores(useBrowser, (s) => s.selection);
export const spaceStore = recordStores(useBrowser, (s) => s.spaces);
export const spaceHeaderHiddenStore = selectStore(useBrowser, spaceHeaderHidden);
export const windowsStore = selectStore(useBrowser, (s) => s.windows);

// The store without `live`, which every page's progress replaces (the most frequent update there is). A selector that
// reads nothing of it follows this and doesn't run then; `BrowserShape` has no `live`, so one that does won't compile.
function withoutLive(): ReadStore<BrowserShape> {
  const listeners = new Set<(state: BrowserShape, prev: BrowserShape) => void>();
  let stop: (() => void) | undefined;
  return {
    getState: useBrowser.getState,
    getInitialState: useBrowser.getInitialState,
    subscribe(listener) {
      listeners.add(listener);
      stop ??= useBrowser.subscribe((s, prev) => {
        for (const key in s) {
          if (key !== "live" && s[key as keyof typeof s] !== prev[key as keyof typeof s]) {
            for (const each of listeners) each(s, prev);
            return;
          }
        }
      });
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          stop?.();
          stop = undefined;
        }
      };
    },
  };
}
export const quietStore = withoutLive();

export const spaceOrderStore = selectStore(useBrowser, (s) => s.spaceOrder);
export const spacesStore = selectStore(useBrowser, (s) => s.spaces);
export const settingsStore = selectStore(useBrowser, (s) => s.settings);
export const appearanceStore = selectStore(useBrowser, (s) => s.ui.appDark);
