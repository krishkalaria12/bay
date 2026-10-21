import { onAppEvent } from "@bay/shell";
import { createBrowserPersistence, type PersistenceOwner } from "../lib/persist";
import { AUTO_CLEAN_EVERY_MS } from "../lib/constants";
import { startLive } from "../live/index";
import { flushLivePersistence, resumeLivePersistence, startLivePersistence } from "../live/store";
import type { BrowserStore } from "../store/browser";

const owners = new WeakMap<BrowserStore, PersistenceOwner>();

/** One background owner per authority. Window entry points never call this.
 * The coordinator supplies an already restored/recovered store; the legacy
 * single-runtime entry restores its disk session here until the startup gate lifts.
 */
export function startCoordinatorServices({ store, restoreSession = false }: { store: BrowserStore; restoreSession?: boolean }): PersistenceOwner {
  const existing = owners.get(store);
  if (existing) return existing;
  const stops: (() => void)[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    owners.delete(store);
    for (const stop of stops.reverse()) {
      try {
        stop();
      } catch (error) {
        console.error("[runtime] background service cleanup failed", error);
      }
    }
  };
  try {
    // Live state must be loaded before the browser and meeting watchers run.
    stops.push(startLivePersistence());
    const persistence = createBrowserPersistence({ store, restoreSession });
    stops.push(() => persistence.dispose());
    stops.push(startLive(store));
    const events = onAppEvent((event) => {
      if (event.type === "resignActive" || event.type === "screenLocked") store.getState().closeAbandonedNewTabs();
    });
    stops.push(() => events.remove());
    const timer = setInterval(() => store.getState().cleanUpInactiveTabs(), AUTO_CLEAN_EVERY_MS);
    stops.push(() => clearInterval(timer));
    const owner: PersistenceOwner = {
      flush(options) {
        if (disposed) return Promise.reject(new Error("Background services are disposed"));
        return Promise.all([persistence.flush(options), flushLivePersistence(options)]).then(() => {});
      },
      resume() {
        if (disposed) return;
        persistence.resume();
        resumeLivePersistence();
      },
      dispose,
    };
    owners.set(store, owner);
    return owner;
  } catch (error) {
    dispose();
    throw error;
  }
}
