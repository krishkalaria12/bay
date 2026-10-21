import "../lib/nativeEvents";
import { batchedUpdates } from "@bay/platform";
import { focusWindow } from "@bay/shell";
import { onExtensionsChanged } from "@bay/nncore";
import { setStoreBatching, useBrowser, type BrowserState } from "../store/browser";
import { restoreBrowserSession } from "../lib/persist";
import { startNativeSync } from "../lib/native";
import { startSync } from "../sync/engine";
import { prepareCoordinatorStore } from "./startup";
import { startCoordinatorServices } from "./services";
import { startServiceStateOwner } from "./serviceState";
import { executeServiceCommand, stopServiceCommands } from "./serviceExecutor";
import { createBrowserCoordinator, type BrowserCoordinatorTransport } from "./coordinator";
import { startExtensionSearchEngines } from "../components/extensions/searchEngines";
import { refreshExtensions } from "../components/extensions/state";
import { engineProfile } from "../store/model";
import { installErrorReporting, startTelemetry } from "../telemetry";
import { startApplicationLifecycle } from "../lib/appIntegration";

export async function startCoordinatorEntry(transport: BrowserCoordinatorTransport, onError: (error: Error) => void) {
  const store = useBrowser;
  setStoreBatching(batchedUpdates);
  installErrorReporting();
  prepareCoordinatorStore(store, transport.bootstrap.recoveryState, restoreBrowserSession);
  let native: ReturnType<typeof startNativeSync> | undefined;
  const coordinator = await createBrowserCoordinator({
    store,
    transport,
    effects: { focusWindow },
    executeAsync: async (command, isActive) => {
      if (command.method !== "serviceAction") throw new Error("Unsupported asynchronous command");
      return executeServiceCommand(store, command, isActive);
    },
    startServices() {
      const stops: (() => void)[] = [];
      let persistence: ReturnType<typeof startCoordinatorServices>;
      try {
        persistence = startCoordinatorServices({
          store,
          afterLiveRestore: () => startServiceStateOwner(store, { restore: transport.bootstrap.recoveryState !== undefined }),
        });
        stops.push(() => persistence.dispose());
        native = startNativeSync({ store, persistence, shared: true });
        stops.push(() => native?.dispose(), startSync(store), startExtensionSearchEngines(store));
        const refresh = () => {
          for (const id of new Set(store.getState().windowOrder.map((id) => engineProfile(store.getState().windows[id]!.spaceId)))) void refreshExtensions(id);
        };
        refresh();
        const extensions = onExtensionsChanged(({ profile }) => void refreshExtensions(profile));
        stops.push(() => extensions.remove());
        stops.push(
          store.subscribe((state, previous) => {
            if (state.windows !== previous.windows) refresh();
          }),
        );
        // Telemetry persistence and application upgrades have one owner too.
        stops.push(startTelemetry());
      } catch (error) {
        for (const stop of stops.reverse()) stop();
        throw error;
      }
      return {
        flush: persistence.flush,
        resume: persistence.resume,
        dispose() {
          stopServiceCommands();
          for (const stop of stops.reverse()) stop();
        },
      };
    },
    onAcceptedCommit: (commit) => native?.reconcile(commit.state as BrowserState),
    onError,
  });
  try {
    await coordinator.announceReady();
    startApplicationLifecycle();
    return coordinator;
  } catch (error) {
    coordinator.dispose();
    throw error;
  }
}
