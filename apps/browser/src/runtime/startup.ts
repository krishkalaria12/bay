import type { JsonValue } from "../lib/json";
import type { AppRuntimeTransport } from "@bay/platform/runtimeTransport";
import { isWindows } from "@bay/platform";
import type { BrowserStore } from "../store/browserStore";
import type { CreateWindowOptions } from "../store/windows";
import type { BrowserProjection } from "./projection";
import type { BrowserCommand } from "./userCommands";

export type SharedRuntimeTransport = AppRuntimeTransport<BrowserProjection, BrowserCommand, unknown>;

export type RuntimeOwner = { dispose(): void };

/** The browser-authenticated role selects one entry. There is no local-writer
 * fallback when a shared connection fails or its epoch changes. */
export async function startSharedRuntime({
  transport,
  coordinator,
  window,
}: {
  transport: SharedRuntimeTransport;
  coordinator(transport: Extract<SharedRuntimeTransport, { bootstrap: { role: "coordinator" } }>): Promise<RuntimeOwner>;
  window(transport: Extract<SharedRuntimeTransport, { bootstrap: { role: "window" } }>): Promise<RuntimeOwner>;
}): Promise<RuntimeOwner> {
  try {
    // SAFETY: the checks above established this shape.
    if (transport.bootstrap.role === "coordinator") {
      // SAFETY: the checks above established this shape.
      return await coordinator(transport as Parameters<typeof coordinator>[0]);
    }

    // SAFETY: the checks above established this shape.
    if (transport.bootstrap.role === "window") {
      // SAFETY: the checks above established this shape.
      return await window(transport as Parameters<typeof window>[0]);
    }

    throw new Error("The browser did not assign a runtime role");
  } catch (error) {
    transport.dispose();
    throw error;
  }
}

/** Disk hydration precedes revision zero only for a new browser epoch. The
 * coordinator's recovery projection is installed by createBrowserCoordinator.
 * With no window to restore, Windows' first one fills the screen, as its browsers' do. */
export function prepareCoordinatorStore(
  store: BrowserStore,
  recoveryState: BrowserProjection | undefined,
  restore: (store: BrowserStore) => JsonValue,
  firstWindow: CreateWindowOptions = isWindows ? { maximized: true } : {},
) {
  if (recoveryState !== undefined) return;
  restore(store);

  if (!store.getState().windowOrder.length) store.getState().createWindow(firstWindow);
}
