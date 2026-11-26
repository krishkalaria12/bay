import { listPlugins, PluginsNative, removePlugin, startPluginSandbox } from "@bay/chromium";
import { keychainDelete, keychainGet, keychainSet, postNotification, readDocument, writeDocument } from "@bay/desktop";
import { live } from "../../activity/activityStore";
import { refreshFolder } from "../../activity/activityEngine";
import { createWindow } from "../../runtime/windowActions";
import type { BrowserStore } from "../../store/browserStore";
import { frontPage, frontPublicWindow } from "./pluginContext";
import { MAX_FETCH_BODY, type FetchInit } from "./protocol";
import type { FetchAnswer, PluginHost } from "./pluginService";

// What plugins reach in Bay, for the coordinator's plugin service: the native plugins folder and sandboxes
// (@bay/chromium), the front window, notifications, live folders, the app's documents and the keychain.

/** bay.fetch: through the engine on Windows and Linux, the app's own fetch on macOS. Never the user's cookies. */
async function pluginFetch(url: string, init: FetchInit): Promise<FetchAnswer> {
  if (PluginsNative?.fetch) return PluginsNative.fetch(url, init.method, init.headers, init.body);
  const response = await fetch(url, { method: init.method, headers: init.headers, body: init.body ?? undefined, credentials: "omit" });
  const body = await response.text();

  if (body.length > MAX_FETCH_BODY) throw new Error("The answer is bigger than 5 MB");
  const headers: Record<string, string> = {};

  response.headers.forEach((value, key) => {
    if (!/^set-cookie2?$/i.test(key)) headers[key.toLowerCase()] = value;
  });

  return { status: response.status, url: response.url || url, headers, body };
}

export function appPluginHost(store: BrowserStore): PluginHost {
  return {
    list: listPlugins,
    remove: removePlugin,
    sandbox: startPluginSandbox,
    fetch: pluginFetch,
    async openTab(url, background) {
      const s = store.getState();
      const windowId = frontPublicWindow(s);

      if (windowId) s.newTab(windowId, { url, background });
      else await createWindow({ url });
    },
    activeTab: () => frontPage(store.getState()),
    notify: (id, title, body) => void postNotification({ id, title, body }).catch(() => {}),
    refreshLive(sourceId) {
      for (const folder of Object.values(live().folders)) if (folder.sources.some((s) => s === sourceId)) void refreshFolder(folder.id, store);
    },
    readDocument,
    writeDocument,
    keychainGet,
    keychainSet: (account, secret) => keychainSet(account, secret).then(() => {}),
    keychainDelete: (account) => keychainDelete(account).then(() => {}),
    now: Date.now,
  };
}
