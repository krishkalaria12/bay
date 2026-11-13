import type { JsonObject } from "./src/lib/json";
import { checked } from "./src/lib/checked";
import "@expo/metro-runtime";
import "expo";
import * as v from "valibot";
import { StyleSheet } from "react-native";
import { installNativeTransport, getNativeHostInfo, readNativeSnapshot } from "@bay/platform/nativeBridge";
import { createMojoTransport, type WebNativeBridgeOptions } from "../../packages/platform/src/mojoTransport";

// A hairline is half a point on the Retina Macs the UI is drawn for, and a whole pixel in react-native-web, so every
// `hairlineWidth * 2` border came out twice as thick. Chromium still draws half a point as one pixel at 1x. Set here,
// before the app's modules load.
// SAFETY: the checks above established this shape.
checked<{ hairlineWidth: number }>(StyleSheet).hairlineWidth = 0.5;

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
  const native = location.protocol === "chrome:" && location.hostname === "bay";

  if (native) {
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

  // The desktop hosts draw the UI in the Inter Bay ships, as macOS draws it in SF Pro.
  if (getNativeHostInfo().platform !== "macos") await loadBundledFont();
  const initializationError = getNativeHostInfo().constants.BayShell?.initializationError;

  if (v.is(v.string(), initializationError) && initializationError) throw new Error(initializationError);

  const shell = getNativeHostInfo().constants.BayShell;

  // chrome://bay always runs the shared runtime: one coordinator document owns the state and each window projects it.
  if (native) {
    const role = shell?.runtimeRole;

    if (role !== "coordinator" && role !== "window") throw new Error("The native host did not assign a runtime role");
    const windowId = shell?.windowId;

    if (role === "window" && (!v.is(v.string(), windowId) || !windowId)) throw new Error("The native host did not assign a window");
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
    >({ ...endpoints, expectedRole: role, ...(role === "window" ? { expectedWindowId: checked<string>(windowId) } : undefined) });

    const { startSharedRuntime } = await import("./src/runtime/startup");

    const owner = await startSharedRuntime({
      transport,
      coordinator: async (transport) => (await import("./src/runtime/coordinatorEntry")).startCoordinatorEntry(transport, showStartupError),
      window: async (transport) => (await import("./src/runtime/windowRuntimeEntry")).startWindowRuntimeEntry(transport, showStartupError),
    });

    addEventListener("pagehide", () => owner.dispose(), { once: true });
    // A test instance whose launcher asked for it (scripts/lib/instance.mjs): a packed bundle isn't __DEV__.
    const isolated = readNativeSnapshot<{ isolatedInstance?: boolean }>("BayApp", "systemInfo")?.isolatedInstance;

    if (isolated && readNativeSnapshot<JsonObject>("BayShell", "documents")?.["dev-harness"] !== undefined)
      (await import("./src/lib/devHarness")).startDevHarness();

    return;
  }

  // The localhost preview has no coordinator, so it runs the single-document entry macOS uses.
  await import("./src/main");
  const [{ AppRegistry }, { useBrowser }] = await Promise.all([import("react-native"), import("./src/store/browserStore")]);
  const hostId = shell?.windowId;
  const windowId = v.is(v.string(), hostId) ? hostId : useBrowser.getState().windowOrder[0];

  if (!windowId) throw new Error("The host did not provide a window to render");
  const rootTag = document.getElementById("root");

  if (!rootTag) throw new Error("The WebUI root element is missing");
  AppRegistry.runApplication("main", { rootTag, initialProps: { windowId } });
}

/** Linux has no one system UI face (Cantarell, Noto Sans, DejaVu Sans...), so Bay draws Inter, the nearest to macOS's
 *  SF Pro, as "Bay UI": first in react-native-web's system stack (patches/react-native-web) and the body's font. It is
 *  local, so waiting for it before the first render costs milliseconds and avoids a flash of the fallback face. */
async function loadBundledFont() {
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

function showStartupError(error: Error) {
  console.error(error);
  const root = document.getElementById("root");

  if (root) {
    root.textContent = `Bay could not start: ${error instanceof Error ? error.message : String(error)}`;
    root.setAttribute("role", "alert");
  }
}

void start().catch(showStartupError);
