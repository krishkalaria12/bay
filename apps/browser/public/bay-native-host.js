// Served only by the trusted WebUI source, outside Metro so Chrome can load Mojo.
if (location.protocol === "chrome:" && location.hostname === "bay") {
  const bindings = import("/native_host.mojom-webui.js");
  globalThis.__bayNativeHostReady = bindings.then(({ NativeHost, NativeHostClientCallbackRouter }) => ({
    remote: NativeHost.getRemote(),
    client: new NativeHostClientCallbackRouter(),
  }));
  // These pipes grant no renderer-selected role. Connect authenticates the
  // primary document against the browser-owned coordinator/window registry.
  globalThis.__bayAppRuntimeReady = bindings.then(({ AppRuntime, AppRuntimeClientCallbackRouter }) => ({
    remote: AppRuntime.getRemote(),
    client: new AppRuntimeClientCallbackRouter(),
  }));
}
