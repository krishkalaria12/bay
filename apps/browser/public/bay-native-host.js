// This module is served only from the trusted WebUI data source. It remains
// outside Metro so generated Mojo resources use Chrome's module loader.
if (location.protocol === "chrome:" && location.hostname === "bay") {
  globalThis.__bayNativeHostReady = import("/native_host.mojom-webui.js").then(({ NativeHost, NativeHostClientCallbackRouter }) => ({
    remote: NativeHost.getRemote(),
    client: new NativeHostClientCallbackRouter(),
  }));
}
