import AVFoundation
import ExpoModulesCore
import WebKit

public class BayEngineModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BayEngine")

    Events("onDownload", "onMediaControl")

    OnCreate { [weak self] in
      // Pages' audio keeps playing with the silent switch on and while Bay is in the background, as in Safari.
      try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
      BayDownloads.shared.emit = { body in self?.sendEvent("onDownload", body) }
    }

    AsyncFunction("openDownload") { (path: String, promise: Promise) in
      BayDownloads.shared.open(path, promise: promise)
    }.runOnQueue(.main)

    AsyncFunction("cancelDownload") { (id: String) in
      BayDownloads.shared.cancel(id)
    }.runOnQueue(.main)

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

    Constant("privateBrowsingSupported") { true }

    AsyncFunction("setContentBlocking") { (files: [String]?, version: String, promise: Promise) in
      let finish: (Result<Int, Error>) -> Void = { result in
        switch result {
        case .success(let rules): promise.resolve(rules)
        case .failure(let error): promise.reject(error)
        }
      }
      // Read only when this version still has to be compiled.
      let read: (() -> String?)? = files.map { files in
        { files.compactMap { URL(string: $0).flatMap { try? String(contentsOf: $0, encoding: .utf8) } }.joined(separator: "\n") }
      }
      let paths = files?.compactMap { URL(string: $0)?.path }
      DispatchQueue.main.async {
        BayContentBlocker.shared.apply(lists: read, version: version, completion: finish)
        BayContentBlocker.shared.loadScriptletEngine(paths: paths, version: version)
      }
    }

    Function("setBlockingPausedHosts") { (hosts: [String]) in
      DispatchQueue.main.async { BayContentBlocker.shared.setPausedHosts(hosts) }
    }

    Function("setTrackingParameters") { (json: String) -> Bool in
      BayTracking.setParameters(json)
    }

    View(BayEngineView.self) {
      Events("onNavigationStateChange", "onNavigationError", "onScroll", "onLinkPress", "onPageMessage")
      Prop("pullToRefreshEnabled", true) { (view: BayEngineView, enabled: Bool) in
        view.pullToRefreshEnabled = enabled
      }
      Prop("private", false) { (view: BayEngineView, isPrivate: Bool) in
        view.isPrivate = isPrivate
      }
      Prop("active", true) { (view: BayEngineView, active: Bool) in
        view.isActive = active
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
      AsyncFunction("evaluate") { (view: BayEngineView, script: String, promise: Promise) in view.evaluate(script, promise) }
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
