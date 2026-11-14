import BackgroundTasks
import ExpoModulesCore
import QuickLook
import UIKit
import UserNotifications
import WebKit

/// Page downloads: files a page sends as attachments, or that WebKit can't show, saved to Documents/Downloads, which
/// the Files app shows under Bay. Updates go to JavaScript through the module's `onDownload` event, so a download
/// keeps reporting after its tab closes.
///
/// Leaving Bay doesn't stop a download (Android does the same with a foreground service and a progress notification):
/// iOS 26 runs each one as a continued-processing task, which the system shows with its own progress and a stop
/// button; older versions, or when the system turns the task down, get the usual background time.
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
    /// True once a failed download has been resumed from its resumeData; a second failure is final.
    var resumed = false
    /// The web view the download came from: WebKit continues a download through it.
    weak var webView: WKWebView?
    /// A private download's session store, held while it runs: the session can end (its last private tab closes)
    /// before the download does, and the next private tab gets a new store either way (BayPrivateBrowsing).
    var privateStore: WKWebsiteDataStore?
    /// The download's BGContinuedProcessingTask on iOS 26, once the system starts it.
    var task: AnyObject?
  }

  private var entries: [ObjectIdentifier: Entry] = [:]
  private var downloads: [String: WKDownload] = [:]
  private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
  /// Whether Bay has asked for notification permission (once per launch, on the first download).
  private var askedToNotify = false

  /// Continued-processing task identifiers: Info.plist allows `<bundle id>.download.*` (app.plugin.js).
  private static let taskPrefix = "\(Bundle.main.bundleIdentifier ?? "bay").download."
  /// Registering an identifier Info.plist doesn't allow crashes, so a build without the plugin's entry skips the task.
  private static let continuedProcessingAllowed: Bool = {
    let permitted = Bundle.main.object(forInfoDictionaryKey: "BGTaskSchedulerPermittedIdentifiers") as? [String] ?? []
    return permitted.contains(BayDownloads.taskPrefix + "*")
  }()

  static var directory: URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Downloads", isDirectory: true)
  }

  func track(_ download: WKDownload, url: URL?, isPrivate: Bool, webView: WKWebView) {
    download.delegate = self
    askToNotify()
    let id = UUID().uuidString
    let filename = Self.cleanFilename(url?.lastPathComponent ?? "")
    entries[ObjectIdentifier(download)] = Entry(id: id, url: url?.absoluteString ?? "", isPrivate: isPrivate, filename: filename, webView: webView,
                                                 privateStore: isPrivate ? webView.configuration.websiteDataStore : nil)
    downloads[id] = download
    holdBackgroundTime()
    startContinuedProcessing(id: id, title: Self.systemTitle(filename, isPrivate: isPrivate))
    // The toast shows at once; WebKit names the file when the response arrives (decideDestination).
    report(download, state: "started", received: 0, total: 0, waiting: "Starting…")
    observe(download)
  }

  /// Reports how far the download has come, at most four times a second.
  private func observe(_ download: WKDownload) {
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

  /// The download failed but left resume data: WebKit carries on through the web view it came from, and the download
  /// it hands back continues into the file the old one had.
  private func resume(_ download: WKDownload, resumeData: Data, entry: Entry) {
    guard let webView = entry.webView else { return }
    webView.resumeDownload(fromResumeData: resumeData) { [weak self] resumed in
      guard let self else { return }
      resumed.delegate = self
      self.entries[ObjectIdentifier(resumed)] = entry
      self.downloads[entry.id] = resumed
      self.observe(resumed)
    }
  }

  func cancel(_ id: String) {
    downloads[id]?.cancel { _ in }
  }

  // MARK: WKDownloadDelegate

  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                completionHandler: @escaping (URL?) -> Void) {
    if let status = (response as? HTTPURLResponse)?.statusCode, !(200...299).contains(status) {
      // nil cancels the download. Reported and forgotten here, so the didFailWithError that may follow finds nothing.
      let message = "The site refused the download (\(status))."
      let entry = entries[ObjectIdentifier(download)]
      report(download, state: "failed", received: 0, total: 0, error: message)
      finish(download, success: false)
      if let entry { notifyDone(id: entry.id, filename: entry.filename, isPrivate: entry.isPrivate, success: false, size: 0, error: message) }
      completionHandler(nil)
      return
    }
    // A resumed download continues into the file it already has; a fresh name would start it over.
    if let entry = entries[ObjectIdentifier(download)], entry.resumed, let resumed = entry.destination {
      completionHandler(resumed)
      return
    }
    let destination = Self.uniqueDestination(for: suggestedFilename)
    entries[ObjectIdentifier(download)]?.filename = destination.lastPathComponent
    entries[ObjectIdentifier(download)]?.destination = destination
    report(download, state: "started", received: 0, total: max(response.expectedContentLength, 0))
    completionHandler(destination)
  }

  func downloadDidFinish(_ download: WKDownload) {
    let entry = entries[ObjectIdentifier(download)]
    let size = entry?.destination.flatMap {
      (try? FileManager.default.attributesOfItem(atPath: $0.path)[.size] as? NSNumber)?.int64Value
    } ?? 0
    report(download, state: "finished", received: size, total: size)
    finish(download, success: true)
    if let entry { notifyDone(id: entry.id, filename: entry.filename, isPrivate: entry.isPrivate, success: true, size: size, error: nil) }
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    let nsError = error as NSError
    let cancelled = nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
    // A dropped connection leaves resume data: continue the same file once, in place, instead of starting over.
    // The partial file stays (deleting it would lose what resume continues from).
    if !cancelled, let resumeData, var entry = entries[ObjectIdentifier(download)], !entry.resumed {
      entry.resumed = true
      entries[ObjectIdentifier(download)] = entry
      resume(download, resumeData: resumeData, entry: entry)
      return
    }
    let entry = entries[ObjectIdentifier(download)]
    let message = cancelled ? nil : Self.failure(nsError)
    report(download, state: cancelled ? "cancelled" : "failed", received: download.progress.completedUnitCount,
           total: download.progress.totalUnitCount, error: message)
    if let destination = entry?.destination {
      try? FileManager.default.removeItem(at: destination)
    }
    finish(download, success: false)
    if let entry, !cancelled {
      notifyDone(id: entry.id, filename: entry.filename, isPrivate: entry.isPrivate, success: false,
                 size: download.progress.completedUnitCount, error: message)
    }
  }

  private func finish(_ download: WKDownload, success: Bool) {
    if let entry = entries.removeValue(forKey: ObjectIdentifier(download)) {
      entry.observation?.invalidate()
      downloads.removeValue(forKey: entry.id)
      if #available(iOS 26.0, *), let task = entry.task as? BGContinuedProcessingTask {
        task.setTaskCompleted(success: success)
      }
    }
    if entries.isEmpty { releaseBackgroundTime() }
  }

  // MARK: Finished notification

  /// Asks for notification permission once, on the first download, as Android asks for POST_NOTIFICATIONS: without it
  /// the finished notification below is silently dropped.
  private func askToNotify() {
    guard !askedToNotify else { return }
    askedToNotify = true
    let center = UNUserNotificationCenter.current()
    center.getNotificationSettings { settings in
      if settings.authorizationStatus == .notDetermined {
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
      }
    }
  }

  /// A finished or failed download says so outside Bay, as Android's notification does. Only while Bay isn't on
  /// screen: in the foreground the download toast already says it. Tapping the notification opens Bay.
  private func notifyDone(id: String, filename: String, isPrivate: Bool, success: Bool, size: Int64, error: String?) {
    guard UIApplication.shared.applicationState != .active else { return }
    let content = UNMutableNotificationContent()
    content.title = Self.systemTitle(filename, isPrivate: isPrivate)
    content.body = success ? "Download complete · \(Self.formatBytes(size))" : (error ?? "The download failed.")
    content.sound = .default
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "bay-download-\(id)", content: content, trigger: nil))
  }

  private func report(_ download: WKDownload, state: String, received: Int64, total: Int64, error: String? = nil, waiting: String? = nil) {
    guard let entry = entries[ObjectIdentifier(download)] else { return }
    var body: [String: Any] = [
      "id": entry.id, "url": entry.url, "filename": entry.filename, "state": state,
      "received": Double(max(received, 0)), "total": Double(max(total, 0)), "private": entry.isPrivate,
    ]
    if let destination = entry.destination { body["path"] = destination.absoluteString }
    if let error { body["error"] = error }
    if let waiting { body["waiting"] = waiting }
    emit?(body)
    if #available(iOS 26.0, *), let task = entry.task as? BGContinuedProcessingTask {
      Self.update(task, title: Self.systemTitle(entry.filename, isPrivate: entry.isPrivate), received: received, total: total)
    }
  }

  /// Why a download failed, in the same words Android uses.
  private static func failure(_ error: NSError) -> String {
    if error.domain == NSURLErrorDomain {
      switch error.code {
      case NSURLErrorNotConnectedToInternet, NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: return "No connection."
      case NSURLErrorTimedOut: return "The site stopped responding."
      case NSURLErrorNetworkConnectionLost: return "The connection dropped before the download finished."
      case NSURLErrorHTTPTooManyRedirects: return "The site redirected too many times."
      case NSURLErrorCannotCreateFile, NSURLErrorCannotWriteToFile: return "Bay couldn't save to Downloads."
      default: break
      }
    }
    if error.domain == NSCocoaErrorDomain && error.code == NSFileWriteOutOfSpaceError { return "There isn't enough space on this phone." }
    return error.localizedDescription
  }

  /// A name that's safe to save under, as on Android (BayDownloads.filenameFor): no path, no characters Files or other
  /// systems refuse, no leading or trailing dots, and at most 150 characters with the extension kept.
  static func cleanFilename(_ raw: String) -> String {
    let last = raw.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
    let unsafe = CharacterSet(charactersIn: "\"*:<>?|").union(.controlCharacters)
    let underscore: Unicode.Scalar = "_"
    var name = String(String.UnicodeScalarView(last.unicodeScalars.map { unsafe.contains($0) ? underscore : $0 }))
    name = name.trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: ".")))
    if name.isEmpty { return "download" }
    if name.count > 150 {
      let ext = String((name as NSString).pathExtension.prefix(10))
      var base = String(name.prefix(150 - ext.count - (ext.isEmpty ? 0 : 1)))
      while base.hasSuffix(".") { base.removeLast() }
      name = ext.isEmpty ? base : "\(base).\(ext)"
    }
    return name
  }

  // MARK: Running in the background

  private func holdBackgroundTime() {
    guard backgroundTask == .invalid else { return }
    backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "bay-downloads") { [weak self] in
      self?.releaseBackgroundTime()
    }
  }

  private func releaseBackgroundTime() {
    guard backgroundTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(backgroundTask)
    backgroundTask = .invalid
  }

  /// Asks iOS 26 to keep this download running after Bay leaves the screen. Submitted while Bay is in front (the user
  /// just started it), as the system requires; it declines when it can't, and the background time above remains.
  private func startContinuedProcessing(id: String, title: String) {
    guard #available(iOS 26.0, *), Self.continuedProcessingAllowed else { return }
    let identifier = Self.taskPrefix + id
    let registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { [weak self] task in
      guard let task = task as? BGContinuedProcessingTask else {
        task.setTaskCompleted(success: false)
        return
      }
      self?.attach(task, to: id)
    }
    guard registered else { return }
    let request = BGContinuedProcessingTaskRequest(identifier: identifier, title: title, subtitle: "Starting…")
    // Start now or not at all: a download that waits its turn would be a confusing system banner.
    request.strategy = .fail
    do {
      try BGTaskScheduler.shared.submit(request)
    } catch {
      NSLog("BayDownloads: continued processing declined: %@", error.localizedDescription)
    }
  }

  @available(iOS 26.0, *)
  private func attach(_ task: BGContinuedProcessingTask, to id: String) {
    guard let download = downloads[id], let entry = entries[ObjectIdentifier(download)] else {
      // It finished before the system got the task going.
      task.setTaskCompleted(success: true)
      return
    }
    // The system's stop button, or it ran out of time for it: cancel, as Android does when its service times out.
    task.expirationHandler = { [weak self] in
      DispatchQueue.main.async { self?.cancel(id) }
    }
    task.progress.totalUnitCount = 100
    entries[ObjectIdentifier(download)]?.task = task
    Self.update(task, title: Self.systemTitle(entry.filename, isPrivate: entry.isPrivate), received: download.progress.completedUnitCount, total: download.progress.totalUnitCount)
  }

  @available(iOS 26.0, *)
  private static func update(_ task: BGContinuedProcessingTask, title: String, received: Int64, total: Int64) {
    let subtitle: String
    if total > 0 {
      let fraction = min(1, Double(max(received, 0)) / Double(total))
      task.progress.completedUnitCount = Int64(fraction * 100)
      subtitle = "\(Int(fraction * 100))% · \(formatBytes(received)) of \(formatBytes(total))"
    } else {
      subtitle = received > 0 ? "\(formatBytes(received)) so far" : "Starting…"
    }
    task.updateTitle(title, subtitle: subtitle)
  }

  /// The system shows the task outside Bay (Lock Screen included): a private tab's file isn't named there, as Android
  /// keeps a private download's notification private.
  private static func systemTitle(_ filename: String, isPrivate: Bool) -> String {
    isPrivate ? "Private download" : filename
  }

  private static func formatBytes(_ bytes: Int64) -> String {
    ByteCountFormatter.string(fromByteCount: max(bytes, 0), countStyle: .file)
  }

  /// `name` in the downloads folder, numbered ("report 2.pdf") when that name is taken.
  private static func uniqueDestination(for suggestedName: String) -> URL {
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let name = cleanFilename(suggestedName)
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
