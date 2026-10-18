import "@expo/metro-runtime";
import "expo";
import { installNativeTransport, getNativeHostInfo } from "@bay/platform/nativeBridge";
import { createMojoTransport, type WebNativeBridgeOptions } from "../../packages/platform/src/mojoTransport";

declare global { var __bayNativeHostReady: Promise<WebNativeBridgeOptions> | undefined; }

async function start() {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  if (location.protocol === "chrome:" && location.hostname === "bay") {
    const deadline = performance.now() + 5000;
    while (!globalThis.__bayNativeHostReady) {
      if (performance.now() >= deadline) throw new Error("Bay's native WebUI bootstrap did not load");
      await new Promise<void>(resolve => setTimeout(resolve, 16));
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const ready = globalThis.__bayNativeHostReady.then(options => {
      if (expired) { options.remote.$?.close?.(); options.client.$.close?.(); }
      return options;
    });
    try {
      const options = await Promise.race([ready, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => { expired = true; reject(new Error("Bay's native WebUI bootstrap did not finish loading")); }, Math.max(0, deadline - performance.now()));
      })]);
      installNativeTransport(await createMojoTransport(options));
    } finally { clearTimeout(timeout); }
  } else if (local) {
    const { createPreviewTransport } = await import("./src/web/previewTransport");
    installNativeTransport(createPreviewTransport());
    document.title = "Bay UI preview";
  } else {
    throw new Error("Bay's UI must run in chrome://bay. The local preview is available only on localhost.");
  }
  const initializationError = getNativeHostInfo().constants.BayShell?.initializationError;
  if (typeof initializationError === "string" && initializationError) throw new Error(initializationError);
  if (getNativeHostInfo().constants.BayShell?.hostingSpike === true) {
    const root = document.getElementById("root");
    if (!root) throw new Error("The WebUI root element is missing");
    const { startHostingSpike } = await import("./src/web/HostingSpike");
    startHostingSpike(root);
    return;
  }
  // The legacy entry owns global document writers. Keep experimental shared
  // mode closed until coordinator and window entries own separate services.
  if (getNativeHostInfo().constants.BayShell?.sharedRuntime === true) {
    throw new Error("The shared runtime entry is not ready. Launch without --bay-shared-runtime.");
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
void start().catch(error => {
  console.error(error);
  const root = document.getElementById("root");
  if (root) { root.textContent = `Bay could not start: ${error instanceof Error ? error.message : String(error)}`; root.setAttribute("role", "alert"); }
});
