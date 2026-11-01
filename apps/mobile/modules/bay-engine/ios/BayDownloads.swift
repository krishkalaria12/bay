import ExpoModulesCore
import QuickLook
import WebKit

/// Page downloads: files a page sends as attachments, or that WebKit can't show, saved to Documents/Downloads, which
/// the Files app shows under Bay. Updates go to JavaScript through the module's `onDownload` event, so a download
/// keeps reporting after its tab closes.
final class BayDownloads: NSObject, WKDownloadDelegate {
  static let shared = BayDownloads()

  /// Set by the module: sends an `onDownload` event.
  var emit: (([String: Any]) -> Void)?

  private struct Entry {
    let id: String
    let url: String
    let isPrivate: Bool
    var filename: String
    var destination: URL?
    var observation: NSKeyValueObservation?
  }

  private var entries: [ObjectIdentifier: Entry] = [:]
  private var downloads: [String: WKDownload] = [:]

  static var directory: URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Downloads", isDirectory: true)
  }

  func track(_ download: WKDownload, url: URL?, isPrivate: Bool) {
    download.delegate = self
    let id = UUID().uuidString
    entries[ObjectIdentifier(download)] = Entry(id: id, url: url?.absoluteString ?? "", isPrivate: isPrivate, filename: url?.lastPathComponent ?? "download")
    downloads[id] = download
    var lastSent: CFTimeInterval = 0
    entries[ObjectIdentifier(download)]?.observation = download.progress.observe(\.fractionCompleted) { [weak self] progress, _ in
      // KVO fires for every chunk received; report progress at most four times a second. The delegate reports the
      // final states, so none are dropped.
      let now = CACurrentMediaTime()
      guard now - lastSent >= 0.25 else { return }
      lastSent = now
      DispatchQueue.main.async { self?.report(download, state: "progress", received: progress.completedUnitCount, total: progress.totalUnitCount) }
    }
  }

  func cancel(_ id: String) {
    downloads[id]?.cancel { _ in }
  }

  // MARK: WKDownloadDelegate

  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                completionHandler: @escaping (URL?) -> Void) {
    let destination = Self.uniqueDestination(for: suggestedFilename)
    entries[ObjectIdentifier(download)]?.filename = destination.lastPathComponent
    entries[ObjectIdentifier(download)]?.destination = destination
    report(download, state: "started", received: 0, total: max(response.expectedContentLength, 0))
    completionHandler(destination)
  }

  func downloadDidFinish(_ download: WKDownload) {
    let size = entries[ObjectIdentifier(download)]?.destination.flatMap {
      (try? FileManager.default.attributesOfItem(atPath: $0.path)[.size] as? NSNumber)?.int64Value
    } ?? 0
    report(download, state: "finished", received: size, total: size)
    finish(download)
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    let cancelled = (error as NSError).code == NSURLErrorCancelled
    report(download, state: cancelled ? "cancelled" : "failed", received: download.progress.completedUnitCount,
           total: download.progress.totalUnitCount, error: cancelled ? nil : error.localizedDescription)
    if let destination = entries[ObjectIdentifier(download)]?.destination {
      try? FileManager.default.removeItem(at: destination)
    }
    finish(download)
  }

  private func finish(_ download: WKDownload) {
    if let entry = entries.removeValue(forKey: ObjectIdentifier(download)) {
      entry.observation?.invalidate()
      downloads.removeValue(forKey: entry.id)
    }
  }

  private func report(_ download: WKDownload, state: String, received: Int64, total: Int64, error: String? = nil) {
    guard let entry = entries[ObjectIdentifier(download)] else { return }
    var body: [String: Any] = [
      "id": entry.id, "url": entry.url, "filename": entry.filename, "state": state,
      "received": Double(max(received, 0)), "total": Double(max(total, 0)), "private": entry.isPrivate,
    ]
    if let destination = entry.destination { body["path"] = destination.absoluteString }
    if let error { body["error"] = error }
    emit?(body)
  }

  /// `name` in the downloads folder, numbered ("report 2.pdf") when that name is taken.
  private static func uniqueDestination(for suggestedName: String) -> URL {
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let clean = suggestedName.replacingOccurrences(of: "/", with: "_").trimmingCharacters(in: .whitespaces)
    let name = clean.isEmpty ? "download" : clean
    let base = (name as NSString).deletingPathExtension
    let ext = (name as NSString).pathExtension
    var candidate = directory.appendingPathComponent(name)
    var number = 2
    while FileManager.default.fileExists(atPath: candidate.path) {
      candidate = directory.appendingPathComponent(ext.isEmpty ? "\(base) \(number)" : "\(base) \(number).\(ext)")
      number += 1
    }
    return candidate
  }

  // MARK: Opening

  private var preview: BayFilePreview?

  /// Shows a downloaded file in Quick Look, which can also share it or save it elsewhere.
  func open(_ path: String, promise: Promise) {
    guard let url = URL(string: path), url.isFileURL, url.path.hasPrefix(Self.directory.path),
          FileManager.default.fileExists(atPath: url.path) else {
      promise.reject("E_DOWNLOAD_MISSING", "The file isn't there anymore.")
      return
    }
    guard let presenter = Self.topViewController() else {
      promise.reject("E_NO_WINDOW", "Bay has no window to show the file in.")
      return
    }
    let preview = BayFilePreview(url: url)
    self.preview = preview
    let controller = QLPreviewController()
    controller.dataSource = preview
    presenter.present(controller, animated: true)
    promise.resolve()
  }

  private static func topViewController() -> UIViewController? {
    let window = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .first { $0.isKeyWindow }
    var top = window?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
  }
}

private final class BayFilePreview: NSObject, QLPreviewControllerDataSource {
  let url: URL

  init(url: URL) {
    self.url = url
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    url as NSURL
  }
}
