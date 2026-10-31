import "@expo/metro-runtime";
import "expo";
import { installNativeTransport, getNativeHostInfo } from "@bay/platform/nativeBridge";
import { createMojoTransport, type WebNativeBridgeOptions } from "../../packages/platform/src/mojoTransport";

declare global {
  var __bayNativeHostReady: Promise<WebNativeBridgeOptions> | undefined;
  var __bayAppRuntimeReady:
    | Promise<{
        remote: import("@bay/platform/runtimeTransport").MojoAppRuntimeRemote;
        client: import("@bay/platform/runtimeTransport").MojoAppRuntimeClientRouter;
      }>
    | undefined;
}

async function start() {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  if (location.protocol === "chrome:" && location.hostname === "bay") {
    const deadline = performance.now() + 5000;
    while (!globalThis.__bayNativeHostReady) {
      if (performance.now() >= deadline) throw new Error("Bay's native WebUI bootstrap did not load");
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const ready = globalThis.__bayNativeHostReady.then((options) => {
      if (expired) {
        options.remote.$?.close?.();
        options.client.$.close?.();
      }
      return options;
    });
    try {
      const options = await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => {
              expired = true;
              reject(new Error("Bay's native WebUI bootstrap did not finish loading"));
            },
            Math.max(0, deadline - performance.now()),
          );
        }),
      ]);
      installNativeTransport(await createMojoTransport(options));
    } finally {
      clearTimeout(timeout);
    }
  } else if (local) {
    const { createPreviewTransport } = await import("./src/web/previewTransport");
    installNativeTransport(createPreviewTransport());
    document.title = "Bay UI preview";
  } else {
    throw new Error("Bay's UI must run in chrome://bay. The local preview is available only on localhost.");
  }
  if (getNativeHostInfo().platform === "linux") await loadLinuxFont();
  const initializationError = getNativeHostInfo().constants.BayShell?.initializationError;
  if (typeof initializationError === "string" && initializationError) throw new Error(initializationError);
  if (getNativeHostInfo().constants.BayShell?.hostingSpike === true) {
    const root = document.getElementById("root");
    if (!root) throw new Error("The WebUI root element is missing");
    const { startHostingSpike } = await import("./src/web/HostingSpike");
    startHostingSpike(root);
    return;
  }
  const shell = getNativeHostInfo().constants.BayShell;
  if (shell?.sharedRuntime === true) {
    const role = shell.runtimeRole;
    if (role !== "coordinator" && role !== "window") throw new Error("The native host did not assign a runtime role");
    const windowId = shell.windowId;
    if (role === "window" && (typeof windowId !== "string" || !windowId)) throw new Error("The native host did not assign a window");
    const ready = globalThis.__bayAppRuntimeReady;
    if (!ready) throw new Error("Bay's authenticated runtime bootstrap did not load");
    const { createAppRuntimeTransport } = await import("@bay/platform/runtimeTransport");
    let runtimeTimer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const pending = ready.then((endpoints) => {
      if (expired) {
        endpoints.remote.$.close();
        endpoints.client.$.close();
      }
      return endpoints;
    });
    const endpoints = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        runtimeTimer = setTimeout(() => {
          expired = true;
          reject(new Error("Bay's runtime bootstrap did not finish loading"));
        }, 15000);
      }),
    ]).finally(() => clearTimeout(runtimeTimer));
    const transport = await createAppRuntimeTransport<
      import("./src/runtime/projection").BrowserProjection,
      import("./src/runtime/userCommands").BrowserCommand,
      unknown
    >({ ...endpoints, expectedRole: role, ...(role === "window" ? { expectedWindowId: windowId as string } : {}) });
    const { startSharedRuntime } = await import("./src/runtime/startup");
    const owner = await startSharedRuntime({
      transport,
      coordinator: async (transport) => (await import("./src/runtime/coordinatorEntry")).startCoordinatorEntry(transport, showStartupError),
      window: async (transport) => (await import("./src/runtime/windowRuntimeEntry")).startWindowRuntimeEntry(transport, showStartupError),
    });
    addEventListener("pagehide", () => owner.dispose(), { once: true });
    return;
  }
  await import("./src/main");
  const [{ AppRegistry }, { useBrowser }] = await Promise.all([import("react-native"), import("./src/store/browser")]);
  const hostId = getNativeHostInfo().constants.BayShell?.windowId;
  const windowId = typeof hostId === "string" ? hostId : useBrowser.getState().windowOrder[0];
  if (!windowId) throw new Error("The host did not provide a window to render");
  const rootTag = document.getElementById("root");
  if (!rootTag) throw new Error("The WebUI root element is missing");
  AppRegistry.runApplication("main", { rootTag, initialProps: { windowId } });
}
/** Linux has no one system UI face (Cantarell, Noto Sans, DejaVu Sans...), so Bay draws Inter, the nearest to macOS's
 *  SF Pro, as "Bay UI": first in react-native-web's system stack (patches/react-native-web) and the body's font. It is
 *  local, so waiting for it before the first render costs milliseconds and avoids a flash of the fallback face. */
async function loadLinuxFont() {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/fonts/bay-ui.css";
  const loaded = new Promise<void>((resolve) => {
    link.onload = link.onerror = () => resolve();
  });
  document.head.append(link);
  await loaded;
  await Promise.race([document.fonts.load('13px "Bay UI"'), new Promise((resolve) => setTimeout(resolve, 1000))]).catch(() => undefined);
}
function showStartupError(error: unknown) {
  console.error(error);
  const root = document.getElementById("root");
  if (root) {
    root.textContent = `Bay could not start: ${error instanceof Error ? error.message : String(error)}`;
    root.setAttribute("role", "alert");
  }
}
void start().catch(showStartupError);
