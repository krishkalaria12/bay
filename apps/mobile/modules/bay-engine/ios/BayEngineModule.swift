import AVFoundation
import ExpoModulesCore
import Photos
import WebKit

public class BayEngineModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BayEngine")

    Events("onDownload", "onMediaControl", "onShare")

    OnCreate { [weak self] in
      // Pages' audio keeps playing with the silent switch on and while Bay is in the background, as in Safari.
      try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
      BayDownloads.shared.emit = { body in self?.sendEvent("onDownload", body) }
      BayMedia.shared.emit = { action in self?.sendEvent("onMediaControl", ["action": action]) }
    }

    AsyncFunction("setMediaSession") { (title: String?, site: String, playing: Bool) in
      if let title {
        BayMedia.shared.update(title: title, site: site, playing: playing)
      } else {
        BayMedia.shared.clear()
      }
    }.runOnQueue(.main)

    AsyncFunction("openDownload") { (path: String, promise: Promise) in
      BayDownloads.shared.open(path, promise: promise)
    }.runOnQueue(.main)

    AsyncFunction("cancelDownload") { (id: String) in
      BayDownloads.shared.cancel(id)
    }.runOnQueue(.main)

    AsyncFunction("saveImage") { (url: String, promise: Promise) in
      BayImages.save(url, promise: promise)
    }.runOnQueue(.main)

    // Voice search (B16): one listen, resolved with the transcript or null.
    AsyncFunction("startListening") { (promise: Promise) in
      BayVoice.listen(promise: promise)
    }.runOnQueue(.main)

    // A share that launched Bay cold (B14): the iOS share extension opens `bay://share?url=…` instead, which the
    // normal linking pipeline answers, so there is nothing here to take.
    AsyncFunction("takeShare") { (promise: Promise) in
      promise.resolve(nil)
    }.runOnQueue(.main)

    AsyncFunction("clearData") { (promise: Promise) in
      WKWebsiteDataStore.default().removeData(
        ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast
      ) {
        do {
          try BayEngineSnapshots.clear()
          try BayEngineTabStates.clear()
          promise.resolve()
        } catch {
          promise.reject(error)
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("pruneSnapshots") { (keep: [String]) in
      BayEngineSnapshots.prune(keeping: keep)
    }

    AsyncFunction("pruneTabStates") { (keep: [String]) in
      BayEngineTabStates.prune(keeping: keep)
    }

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
      Events("onNavigationStateChange", "onNavigationError", "onScroll", "onLinkPress", "onPageMessage", "onFullscreenChange", "onPageRequest", "onNewWindow")
      Prop("pullToRefreshEnabled", true) { (view: BayEngineView, enabled: Bool) in
        view.pullToRefreshEnabled = enabled
      }
      Prop("private", false) { (view: BayEngineView, isPrivate: Bool) in
        view.isPrivate = isPrivate
      }
      Prop("active", true) { (view: BayEngineView, active: Bool) in
        view.isActive = active
      }
      Prop("suspended", false) { (view: BayEngineView, suspended: Bool) in
        view.isSuspended = suspended
      }
      Prop("stateKey") { (view: BayEngineView, key: String?) in
        view.stateKey = key
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
      AsyncFunction("saveState") { (view: BayEngineView) in view.saveState() }.runOnQueue(.main)
      AsyncFunction("evaluate") { (view: BayEngineView, script: String, promise: Promise) in view.evaluate(script, promise) }
      AsyncFunction("answerPageRequest") { (view: BayEngineView, id: String, accepted: Bool, value: String?, username: String?, password: String?) in
        view.answerPageRequest(id: id, accepted: accepted, value: value, username: username, password: password)
      }.runOnQueue(.main)
    }
  }
}

// Saving images (B13): fetched, then added to the user's photo library, as Safari's image menu does.
enum BayImages {
  static func save(_ urlString: String, promise: Promise) {
    guard
      let url = URL(string: urlString),
      let scheme = url.scheme?.lowercased(),
      scheme == "http" || scheme == "https"
    else {
      promise.reject("E_IMAGE_URL", "Bay can only save web images.")
      return
    }
    // Some CDNs answer only a browser; URLSession's own agent gets 403s, so Bay presents as it loads the page.
    var request = URLRequest(url: url)
    request.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", forHTTPHeaderField: "User-Agent")
    URLSession.shared.dataTask(with: request) { data, _, error in
      guard error == nil, let data, let image = UIImage(data: data) else {
        DispatchQueue.main.async { promise.reject("E_IMAGE_FETCH", "The image couldn't be downloaded.") }
        return
      }
      let adding = PHPhotoLibrary.authorizationStatus(for: .addOnly)
      if adding == .authorized || adding == .limited {
        add(image, promise: promise)
      } else {
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
          DispatchQueue.main.async {
            if status == .authorized || status == .limited { add(image, promise: promise) }
            else { promise.reject("E_PHOTOS_DENIED", "Bay needs Photos access to save images.") }
          }
        }
      }
    }.resume()
  }

  private static func add(_ image: UIImage, promise: Promise) {
    PHPhotoLibrary.shared().performChanges {
      PHAssetChangeRequest.creationRequestForAsset(from: image)
    } completionHandler: { done, _ in
      DispatchQueue.main.async {
        if done { promise.resolve() } else { promise.reject("E_PHOTOS_SAVE", "The image couldn't be saved.") }
      }
    }
  }
}

// Snapshots outlive their views so closed and archived tabs can retain thumbnails.
enum BayEngineSnapshots {
  static var directory: URL? {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
      .appendingPathComponent("bay-engine-snapshots", isDirectory: true)
  }

  /// Deletes snapshots that aren't in `keep` (file URLs). Recent files stay: their tab may not have been told yet.
  static func prune(keeping keep: [String]) {
    guard let directory else { return }
    let names = Set(keep.compactMap { URL(string: $0)?.lastPathComponent })
    let cutoff = Date().addingTimeInterval(-30)
    let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
    for file in files where !names.contains(file.lastPathComponent) {
      let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantFuture
      if modified < cutoff { try? FileManager.default.removeItem(at: file) }
    }
  }

  static func clear() throws {
    if let directory, FileManager.default.fileExists(atPath: directory.path) {
      try FileManager.default.removeItem(at: directory)
    }
  }
}

/// Tab state files (B6): WebKit's `interactionState` archived per tab id, in the caches directory, so a relaunch or a
/// remounted tab gets its history, scroll position and form text back. Private tabs never write one.
enum BayEngineTabStates {
  static var directory: URL? {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
      .appendingPathComponent("bay-engine-tab-states", isDirectory: true)
  }

  /// Tab ids are the key; anything else is refused, so a key can never name a file outside the directory.
  private static func isSafeKey(_ key: String) -> Bool {
    !key.isEmpty && key.count <= 120 && key.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil
  }

  private static func file(for key: String) -> URL? {
    guard isSafeKey(key), let directory else { return nil }
    return directory.appendingPathComponent("\(key).state")
  }

  static func save(_ state: Any, key: String) {
    guard let file = file(for: key) else { return }
    do {
      try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      // WebKit's state is its own opaque archive, so secure coding can't be required to read it back.
      let data = try NSKeyedArchiver.archivedData(withRootObject: state, requiringSecureCoding: false)
      try data.write(to: file, options: .atomic)
    } catch {
      NSLog("BayEngineTabStates: couldn't save %@: %@", key, error.localizedDescription)
    }
  }

  static func load(key: String) -> Any? {
    guard let file = file(for: key), let data = try? Data(contentsOf: file) else { return nil }
    return try? NSKeyedUnarchiver.unarchiveTopLevelObjectWithData(data)
  }

  /// Deletes states whose tab ids aren't in `keep`. Recent files stay: their tab may not have been told yet.
  static func prune(keeping keep: [String]) {
    guard let directory else { return }
    let names = Set(keep.filter(isSafeKey))
    let cutoff = Date().addingTimeInterval(-30)
    let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
    for file in files where !names.contains(file.deletingPathExtension().lastPathComponent) {
      let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantFuture
      if modified < cutoff { try? FileManager.default.removeItem(at: file) }
    }
  }

  static func clear() throws {
    if let directory, FileManager.default.fileExists(atPath: directory.path) {
      try FileManager.default.removeItem(at: directory)
    }
  }
}
