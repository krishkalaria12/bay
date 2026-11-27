import Foundation
import Photos
import UIKit

/// Answers a save once: done, or why not.
typealias Reply = (Result<Void, Error>) -> Void

// Saving images (B13): fetched, then added to the user's photo library, as Safari's image menu does.
enum BayImages {
  static func save(_ urlString: String, promise: @escaping Reply) {
    guard
      let url = URL(string: urlString),
      let scheme = url.scheme?.lowercased(),
      scheme == "http" || scheme == "https"
    else {
      promise(.failure(EngineError.imageAddress))
      return
    }
    // Some CDNs answer only a browser; URLSession's own agent gets 403s, so Bay presents as it loads the page.
    var request = URLRequest(url: url)
    request.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", forHTTPHeaderField: "User-Agent")
    URLSession.shared.dataTask(with: request) { data, _, error in
      guard error == nil, let data, let image = UIImage(data: data) else {
        DispatchQueue.main.async { promise(.failure(EngineError.imageFetch)) }
        return
      }
      let adding = PHPhotoLibrary.authorizationStatus(for: .addOnly)
      if adding == .authorized || adding == .limited {
        add(image, promise: promise)
      } else {
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
          DispatchQueue.main.async {
            if status == .authorized || status == .limited { add(image, promise: promise) }
            else { promise(.failure(EngineError.photosDenied)) }
          }
        }
      }
    }.resume()
  }

  private static func add(_ image: UIImage, promise: @escaping Reply) {
    PHPhotoLibrary.shared().performChanges {
      PHAssetChangeRequest.creationRequestForAsset(from: image)
    } completionHandler: { done, _ in
      DispatchQueue.main.async {
        promise(done ? .success(()) : .failure(EngineError.photosSave))
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
