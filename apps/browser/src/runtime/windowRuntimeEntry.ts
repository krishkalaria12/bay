import type { WindowRuntimeTransport } from "@bay/platform/runtimeTransport";
import type { BrowserProjection } from "./projection";
import type { BrowserCommand } from "./userCommands";
import { createBrowserClient } from "./client";
import { createClientBrowserReadSource, installBrowserReadSource } from "../store/read";
import { createClientBrowserCommands, installBrowserCommands } from "./commands";
import { installServiceClient } from "./serviceClient";
import { installServiceState } from "./serviceState";
import { setSpaceProfiles } from "../store/model";
import { profileIdOf } from "../store/spaces";
import { parseServiceCommand } from "./serviceCommands";
import { isUtilityWindowId } from "../components/settings/windows";

export async function startWindowRuntimeEntry(transport: WindowRuntimeTransport<BrowserProjection, BrowserCommand, unknown>, onError: (error: Error) => void) {
  const client = createBrowserClient({ clientId: transport.bootstrap.clientId, transport });
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    // The read, command and service clients stay installed until this document is replaced (they are
    // never uninstalled): returning to the local singleton would create a second writer after disconnect.
    client.close();
    transport.dispose();
  }
  try {
    await client.ready;
    // A utility window (Settings, Import, Task Manager) has no browser window record.
    const { windowId } = transport.bootstrap;
    if (!isUtilityWindowId(windowId) && !client.getSnapshot()?.state.windows[windowId]) throw new Error("The assigned browser window is unavailable");
    installBrowserReadSource(createClientBrowserReadSource(client));
    installBrowserCommands(createClientBrowserCommands(client));
    installServiceClient((action, args) => client.dispatch(parseServiceCommand({ method: "serviceAction", action, args })));
    const syncServices = () => {
      if (client.getStatus() === "closed") {
        dispose();
        onError(new Error("The browser runtime disconnected. Reload this window to reconnect."));
        return;
      }
      const state = client.getSnapshot()!.state;
      setSpaceProfiles(Object.fromEntries(Object.values(state.spaces).map((space) => [space.id, profileIdOf(space)])));
      installServiceState(state.services);
    };
    syncServices();
    client.subscribe(syncServices);
    const { startWindowMain } = await import("./windowMain");
    if (disposed) throw new Error("The browser runtime disconnected before mounting");
    startWindowMain();
    const { AppRegistry } = await import("react-native");
    const rootTag = document.getElementById("root");
    if (!rootTag) throw new Error("The WebUI root element is missing");
    AppRegistry.runApplication("main", { rootTag, initialProps: { windowId } });
    return { dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
