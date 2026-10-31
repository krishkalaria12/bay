import type { NativeHostInfo, NativeTransport, JSONValue } from "@bay/platform/nativeBridge";

/** Local UI fixture. This transport is never selected by a privileged WebUI. */
export function createPreviewTransport(): NativeTransport {
  const query = new URLSearchParams(location.search);
  const documents: Record<string, JSONValue> = query.has("onboarding")
    ? {}
    : {
        "onboarding.json": JSON.stringify({ version: 1, completedAt: 1 }),
      };
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const info: NativeHostInfo = {
    contractVersion: 2,
    // ?platform=linux previews the Linux host's look (no caption buttons, its UI font and icons).
    platform: query.get("platform") === "linux" ? "linux" : "windows",
    modules: ["BayCEF", "BayShell", "BayApp", "BaySystem", "BayKeychain", "BayImport", "BayChromeUI", "BayExtensions"],
    views: [],
    optionalMethods: [
      "BaySystem.downloadsFolder",
      "BayShell.minimizeWindow",
      "BayShell.toggleMaximizeWindow",
      "BayShell.windowState",
      "BayShell.setWindowCaption",
    ],
    constants: { BayApp: { apiVersion: 9 }, BayShell: { preview: true, hostingSpike: query.has("spike") } },
    snapshots: {
      BayShell: { documents, windowButtonLayout: { left: [], right: ["minimize", "maximize", "close"] } },
      BaySystem: { files: {}, downloadsFolder: null },
      BayApp: {
        environment: {},
        systemInfo: {
          appName: "Bay",
          appVersion: "0.0.0",
          appBuild: "web-preview",
          bundleId: "Bay.Preview",
          configuration: "Debug",
          osVersion: "Web preview",
          osBuild: "",
          arch: "web",
          model: "Desktop browser",
          memoryGB: 0,
          locale: navigator.language,
          updates: false,
          isolatedInstance: true,
        },
      },
    },
  };
  const emit = (module: string, event: string, value: unknown) => {
    for (const listener of listeners.get(`${module}.${event}`) ?? []) listener(value);
  };
  const windows = new Set<string>();
  const noResult = new Set([
    "BayShell.setAppearance",
    "BayShell.setMenuState",
    "BayShell.setMenuBookmarks",
    "BayShell.setWindowTitle",
    "BayShell.focusWindow",
    "BayShell.setSwitcherCapture",
    "BayShell.setTrafficLightsCenter",
    "BayShell.setTrafficLightsOnHover",
    "BayShell.minimizeWindow",
    "BayShell.toggleMaximizeWindow",
    "BayShell.setWindowCaption",
    "BayApp.setWindowActivity",
    "BayApp.setScriptState",
    "BayApp.removeNotifications",
    "BaySystem.hapticTick",
    "BayCEF.prepareTransfer",
    "BayCEF.releaseTransfer",
    "BayCEF.watchDownloads",
    "BayCEF.watchContentBlocker",
    "BayCEF.watchHistory",
    "BayCEF.watchBookmarks",
    "BayCEF.watchPreferences",
    "BayCEF.releaseProfile",
    "BayCEF.setDisplayMediaPicker",
    "BayChromeUI.watchCastRoutes",
    "BayCEF.setSearchEngineName",
  ]);
  return {
    getHostInfo: () => info,
    subscribe(module, event, listener) {
      const key = `${module}.${event}`;
      let values = listeners.get(key);
      if (!values) listeners.set(key, (values = new Set()));
      values.add(listener);
      return {
        remove: () => {
          values.delete(listener);
        },
      };
    },
    async invoke(module, method, json) {
      const args: unknown[] = JSON.parse(json);
      const key = `${module}.${method}`;
      const ok = (value: unknown = null) => JSON.stringify({ value });
      if (noResult.has(key)) return ok();
      switch (key) {
        case "BayShell.readDocument":
          return ok(documents[String(args[0])] ?? null);
        case "BayShell.writeDocument":
        case "BayShell.saveDocument":
          documents[String(args[0])] = String(args[1]);
          return ok();
        case "BayShell.removeDocument":
          delete documents[String(args[0])];
          return ok();
        case "BayShell.openWindow":
          windows.add(String(args[0]));
          return ok();
        case "BayShell.closeWindow":
          windows.delete(String(args[0]));
          emit("BayShell", "onWindowEvent", { type: "close", id: args[0] });
          return ok();
        case "BayShell.windowIds":
          return ok([...windows]);
        case "BayShell.windowState":
          return ok({ maximized: false, fullscreen: false });
        case "BayShell.isDarkAppearance":
          return ok(matchMedia("(prefers-color-scheme: dark)").matches);
        case "BayShell.showMenu":
          return ok();
        case "BayShell.confirm":
          return ok({ confirmed: false, suppressed: false });
        case "BayShell.prompt":
          return ok();
        case "BayApp.updaterState":
          return ok({ available: false });
        case "BayApp.notificationPermission":
          return ok("denied");
        case "BayApp.postNotification":
          return ok();
        case "BayApp.crashReports":
          return ok([]);
        case "BaySystem.isDefaultBrowser":
          return ok(false);
        case "BaySystem.launchAtLoginStatus":
          return ok("notRegistered");
        case "BaySystem.menuShortcuts":
          return ok([]);
        case "BaySystem.fileIcon":
          return ok();
        case "BayKeychain.get":
          return ok();
        case "BayCEF.chromeWindows":
          return ok([]);
        case "BayCEF.tabStrips":
          return ok([]);
        case "BayCEF.systemState":
          return ok({});
        case "BayCEF.downloads":
          return ok([]);
        case "BayCEF.engineInfo":
          return ok({ version: "UI preview", chromium: "154", cef: "", userAgent: navigator.userAgent });
        case "BayExtensions.list":
          return ok({ extensions: [] });
        case "BayExtensions.searchEngineList":
          return ok({ list: { engines: [] } });
        case "BayImport.listBrowsers":
          return ok("[]");
        case "BayCEF.engineCall": {
          if (args[0] === "nn_bookmarks_tree")
            return ok(
              JSON.stringify({
                bar: { id: "bar", k: "f", t: "Bookmarks bar", a: 0, c: [] },
                other: { id: "other", k: "f", t: "Other bookmarks", a: 0, c: [] },
              }),
            );
          if (args[0] === "nn_favicons_get") return ok(JSON.stringify({ pages: {}, icons: {} }));
          return ok(JSON.stringify({ ok: true, entries: [], engines: [], visits: [] }));
        }
        case "BayWebView.mount":
          return ok({ surfaceId: "", browserId: Number(args[0]), chromeTabId: Number(args[0]) });
        case "BayWebView.update":
        case "BayWebView.unmount":
          return ok();
        case "BayWebView.call": {
          const command = String(args[1]);
          if (["executeJavaScript", "focus", "loadUrl", "setMuted", "setFrozen", "stopLoading", "reload", "forceReload"].includes(command)) return ok();
          if (command === "discard") return ok("refused");
          break;
        }
      }
      console.warn(`[bay preview] Native service unavailable: ${key}`);
      return JSON.stringify({ error: { code: "preview_unavailable", message: `${key} needs the native Chrome host` } });
    },
    dispose() {
      listeners.clear();
    },
  };
}
