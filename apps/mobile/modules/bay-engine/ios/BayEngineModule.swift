import ExpoModulesCore
import WebKit

public class BayEngineModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BayEngine")

    AsyncFunction("clearData") { (promise: Promise) in
      WKWebsiteDataStore.default().removeData(
        ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast
      ) {
        do {
          try BayEngineSnapshots.clear()
          promise.resolve()
        } catch {
          promise.reject(error)
        }
      }
    }.runOnQueue(.main)

    View(BayEngineView.self) {
      Events("onNavigationStateChange", "onNavigationError", "onScroll", "onLinkPress")
      Prop("pullToRefreshEnabled", true) { (view: BayEngineView, enabled: Bool) in
        view.pullToRefreshEnabled = enabled
      }
      Prop("initialUrl") { (view: BayEngineView, url: String?) in
        view.loadInitial(url)
      }

      AsyncFunction("load") { (view: BayEngineView, url: String) in try view.load(url) }
      AsyncFunction("goBack") { (view: BayEngineView) in _ = view.webView.goBack() }
      AsyncFunction("goForward") { (view: BayEngineView) in _ = view.webView.goForward() }
      AsyncFunction("reload") { (view: BayEngineView) in _ = view.webView.reload() }
      AsyncFunction("stop") { (view: BayEngineView) in view.stop() }
      AsyncFunction("snapshot") { (view: BayEngineView, promise: Promise) in view.snapshot(promise) }
    }
  }
}

// Snapshots outlive their views so closed and archived tabs can retain thumbnails.
enum BayEngineSnapshots {
  static var directory: URL? {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
      .appendingPathComponent("bay-engine-snapshots", isDirectory: true)
  }

  static func clear() throws {
    if let directory, FileManager.default.fileExists(atPath: directory.path) {
      try FileManager.default.removeItem(at: directory)
    }
  }
}
