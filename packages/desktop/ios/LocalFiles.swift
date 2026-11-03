import AppKit
import ExpoModulesCore
import UniformTypeIdentifiers

private let localFileQueue = DispatchQueue(label: "bay.local-files", qos: .userInitiated)

// This file is never part of a session or sync payload. A path arriving through sync does not grant access.
// Keep one security-scope lease per root for the process: Chromium reads tabs/uploads asynchronously.
final class LocalFileBookmarks {
  static let shared = LocalFileBookmarks()
  private var bookmarks: [String: Data] = [:]
  private var resolved: [String: URL] = [:]
  private var leases: [String: URL] = [:]
  private let lock = NSRecursiveLock()
  private var terminationObserver: NSObjectProtocol?

  private init() {
    if let url = try? ShellModule.documentURL("local-file-access.plist"),
       let data = try? Data(contentsOf: url),
       let saved = try? PropertyListDecoder().decode([String: Data].self, from: data) {
      bookmarks = saved
    }
    terminationObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.willTerminateNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.releaseAll() }
  }

  deinit {
    if let terminationObserver { NotificationCenter.default.removeObserver(terminationObserver) }
    releaseAll()
  }

  private func releaseAll() {
    lock.lock()
    defer { lock.unlock() }
    for url in leases.values { url.stopAccessingSecurityScopedResource() }
    leases.removeAll()
    resolved.removeAll()
  }

  private func save() throws {
    let url = try ShellModule.documentURL("local-file-access.plist")
    try PropertyListEncoder().encode(bookmarks).write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }

  // Called only with URLs from AppKit's drop/picker, never with an untrusted JS path.
  func grant(_ url: URL, alias: String? = nil) throws -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    guard url.isFileURL else { throw CocoaError(.fileReadUnsupportedScheme) }
    let url = url.standardizedFileURL
    let temporaryAccess = url.startAccessingSecurityScopedResource()
    defer { if temporaryAccess { url.stopAccessingSecurityScopedResource() } }
    let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isReadableKey])
    guard values.isReadable != false else { throw CocoaError(.fileReadNoPermission) }
    let data = try url.bookmarkData(options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess], includingResourceValuesForKeys: nil, relativeTo: nil)
    let keys = Set([url.path, alias ?? url.path])
    let previous = bookmarks
    for key in keys { bookmarks[key] = data }
    do { try save() } catch { bookmarks = previous; throw error }
    // Reconnecting a root replaces its lease too. The alias keeps existing pins and undo snapshots valid.
    for key in keys {
      if let old = leases.removeValue(forKey: key) { old.stopAccessingSecurityScopedResource() }
      resolved.removeValue(forKey: key)
    }
    return ["path": url.path, "name": url.lastPathComponent, "kind": values.isDirectory == true ? "folder" : "file"]
  }

  private func root(_ path: String) -> URL? {
    // Grants are keyed by the standardized path (/private/var/… is stored as /var/…).
    let path = bookmarks[path] == nil ? URL(fileURLWithPath: path).standardizedFileURL.path : path
    if let cached = resolved[path], FileManager.default.fileExists(atPath: cached.path) { return cached }
    if let old = leases.removeValue(forKey: path) { old.stopAccessingSecurityScopedResource() }
    resolved.removeValue(forKey: path)
    guard let data = bookmarks[path] else { return nil }
    var stale = false
    guard let url = try? URL(resolvingBookmarkData: data, options: [.withSecurityScope, .withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale) else { return nil }
    let accessing = url.startAccessingSecurityScopedResource()
    if accessing { leases[path] = url }
    resolved[path] = url
    // A non-App-Sandbox build may not need a scope, but the native bookmark is still required.
    if stale, let refreshed = try? url.bookmarkData(options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess], includingResourceValuesForKeys: nil, relativeTo: nil) {
      let previous = bookmarks
      bookmarks[path] = refreshed
      do { try save() } catch { bookmarks = previous }
    }
    return url
  }

  // Reject traversal and symlink escapes. A folder bookmark is authority only for that folder's descendants.
  func authorizedURL(_ path: String, _ relative: String) -> URL? {
    lock.lock()
    defer { lock.unlock() }
    guard !relative.hasPrefix("/"), !relative.split(separator: "/").contains(".."), let root = root(path) else { return nil }
    let base = root.resolvingSymlinksInPath().standardizedFileURL
    let url = relative.isEmpty ? base : base.appendingPathComponent(relative).resolvingSymlinksInPath().standardizedFileURL
    guard url.path == base.path || url.path.hasPrefix(base.path.hasSuffix("/") ? base.path : base.path + "/") else { return nil }
    return url
  }

  func inspect(_ path: String, _ relative: String) -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    guard let url = authorizedURL(path, relative) else {
      // No local grant means inaccessible even if an unrelated file happens to occupy the same synced path.
      return ["status": FileManager.default.fileExists(atPath: path) ? "inaccessible" : "missing"]
    }
    do {
      let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isReadableKey, .contentTypeKey])
      guard values.isReadable != false else { return ["status": "inaccessible"] }
      let directory = values.isDirectory == true
      let type = values.contentType
      let readable = !directory && (type?.conforms(to: .pdf) == true || type?.conforms(to: .image) == true || type?.conforms(to: .html) == true)
      return ["status": "available", "path": url.path, "name": url.lastPathComponent,
              "kind": directory ? "folder" : "file", "url": url.absoluteString, "browserReadable": readable]
    } catch {
      let nsError = error as NSError
      let missing = nsError.domain == NSCocoaErrorDomain && [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(nsError.code)
      return ["status": missing ? "missing" : "inaccessible"]
    }
  }

  func list(_ path: String, _ relative: String) -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    let access = inspect(path, relative)
    guard access["status"] as? String == "available", access["kind"] as? String == "folder",
          let url = authorizedURL(path, relative) else { return ["access": access, "entries": []] }
    do {
      let urls = try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey], options: [.skipsHiddenFiles])
      let entries: [[String: Any]] = urls.compactMap { child in
        let relativePath = relative.isEmpty ? child.lastPathComponent : relative + "/" + child.lastPathComponent
        guard authorizedURL(path, relativePath) != nil,
              let values = try? child.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]) else { return nil }
        // A symlink back to an ancestor must not create an infinitely expandable tree.
        if values.isSymbolicLink == true,
           (try? child.resolvingSymlinksInPath().resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true { return nil }
        return ["path": child.path, "relativePath": relativePath, "name": child.lastPathComponent, "kind": values.isDirectory == true ? "folder" : "file"]
      }.sorted {
        let lhsFolder = $0["kind"] as? String == "folder", rhsFolder = $1["kind"] as? String == "folder"
        if lhsFolder != rhsFolder { return lhsFolder }
        return ($0["name"] as? String ?? "").localizedStandardCompare($1["name"] as? String ?? "") == .orderedAscending
      }
      return ["access": access, "entries": entries]
    } catch { return ["access": ["status": "inaccessible"], "entries": []] }
  }

  func open(_ path: String, _ relative: String) -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    let access = inspect(path, relative)
    guard access["status"] as? String == "available", let url = authorizedURL(path, relative) else { return access }
    if access["browserReadable"] as? Bool != true, !NSWorkspace.shared.open(url) { return ["status": "inaccessible"] }
    return access
  }
}

public class LocalFilesModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BayLocalFiles")
    AsyncFunction("inspect") { (root: String, relative: String) -> [String: Any] in LocalFileBookmarks.shared.inspect(root, relative) }.runOnQueue(localFileQueue)
    AsyncFunction("list") { (root: String, relative: String) -> [String: Any] in LocalFileBookmarks.shared.list(root, relative) }.runOnQueue(localFileQueue)
    AsyncFunction("open") { (root: String, relative: String) -> [String: Any] in LocalFileBookmarks.shared.open(root, relative) }.runOnQueue(.main)
    // Hidden-instance acceptance only. These deliver NSURL pasteboards through the mounted native destinations.
    AsyncFunction("devDrop") { (windowId: String, paths: [String]) -> [String: Any] in
      LocalFileAcceptance.drop(windowId, paths)
    }.runOnQueue(.main)
    AsyncFunction("devUpload") { (windowId: String, root: String, relative: String, x: Double, y: Double, promise: Promise) in
      LocalFileAcceptance.upload(windowId, root, relative, NSPoint(x: x, y: y)) { promise.resolve($0) }
    }.runOnQueue(.main)
    AsyncFunction("reconnect") { (root: String, kind: String?, promise: Promise) in
      let panel = NSOpenPanel()
      panel.canChooseFiles = kind != "folder"
      panel.canChooseDirectories = kind != "file"
      panel.allowsMultipleSelection = false
      panel.message = "Choose the file or folder to make available on this Mac."
      panel.prompt = "Allow Access"
      panel.directoryURL = URL(fileURLWithPath: root).deletingLastPathComponent()
      panel.begin { result in
        guard result == .OK, let url = panel.url else { return promise.resolve(nil) }
        do { promise.resolve(try LocalFileBookmarks.shared.grant(url, alias: root)) }
        catch { promise.reject("ERR_LOCAL_FILE_ACCESS", error.localizedDescription) }
      }
    }.runOnQueue(.main)
    View(LocalFilesArea.self) {
      Events("onFilesDropped", "onFilesDropError", "onDropActive", "onActivate", "onContextMenu")
      Prop("dropEnabled") { (view: LocalFilesArea, enabled: Bool) in view.dropEnabled = enabled }
      Prop("rootPath") { (view: LocalFilesArea, path: String?) in view.rootPath = path }
      Prop("relativePath") { (view: LocalFilesArea, path: String?) in view.relativePath = path ?? "" }
    }
  }
}

final class LocalFilesArea: ExpoView, NSDraggingSource {
  let onFilesDropped = EventDispatcher()
  let onFilesDropError = EventDispatcher()
  let onDropActive = EventDispatcher()
  let onActivate = EventDispatcher()
  let onContextMenu = EventDispatcher()
  var dropEnabled = false {
    didSet {
      if dropEnabled { registerForDraggedTypes([.fileURL]) } else { unregisterDraggedTypes() }
    }
  }
  var rootPath: String?
  var relativePath = ""
  private var downAt: NSPoint?
  private var dragged = false

  override func hitTest(_ point: NSPoint) -> NSView? {
    let hit = super.hitTest(point)
    return rootPath != nil && hit != nil ? self : hit
  }

  private func droppedURLs(_ sender: NSDraggingInfo) -> [URL] {
    (sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
  }

  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
    guard dropEnabled, !droppedURLs(sender).isEmpty else { return [] }
    onDropActive(["active": true])
    return .copy
  }
  override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { dropEnabled ? .copy : [] }
  override func draggingExited(_ sender: NSDraggingInfo?) { onDropActive(["active": false]) }
  override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool { dropEnabled && !droppedURLs(sender).isEmpty }
  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
    onDropActive(["active": false])
    guard dropEnabled else { return false }
    var files: [[String: Any]] = []
    for url in droppedURLs(sender) {
      do { files.append(try LocalFileBookmarks.shared.grant(url)) }
      catch { onFilesDropError(["message": "Could not pin \(url.lastPathComponent): \(error.localizedDescription)"]) }
    }
    guard !files.isEmpty else { return false }
    onFilesDropped(["files": files])
    return true
  }

  override func mouseDown(with event: NSEvent) {
    guard rootPath != nil else { return super.mouseDown(with: event) }
    if event.modifierFlags.contains(.control) { onContextMenu([:]); return }
    downAt = event.locationInWindow
    dragged = false
  }
  override func mouseDragged(with event: NSEvent) {
    guard !dragged, let start = downAt, let rootPath,
          hypot(event.locationInWindow.x - start.x, event.locationInWindow.y - start.y) > 4,
          let item = LocalFileNativeDrag.item(rootPath, relativePath), let url = item.item as? URL else { return }
    dragged = true
    let point = convert(event.locationInWindow, from: nil)
    item.setDraggingFrame(NSRect(x: point.x - 16, y: point.y - 16, width: 32, height: 32), contents: NSWorkspace.shared.icon(forFile: url.path))
    beginDraggingSession(with: [item], event: event, source: self)
  }
  override func mouseUp(with event: NSEvent) {
    if downAt != nil, !dragged { onActivate([:]) }
    downAt = nil
  }
  override func rightMouseDown(with event: NSEvent) { onContextMenu([:]) }
  override func accessibilityPerformPress() -> Bool { onActivate([:]); return true }
  func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
  func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) { downAt = nil }
}

// Shared by the actual row drag and the hidden-instance upload check. Never turn a synced path into a grant.
enum LocalFileNativeDrag {
  static func item(_ root: String, _ relative: String) -> NSDraggingItem? {
    guard LocalFileBookmarks.shared.inspect(root, relative)["status"] as? String == "available",
          let url = LocalFileBookmarks.shared.authorizedURL(root, relative) else { return nil }
    return NSDraggingItem(pasteboardWriter: url as NSURL)
  }

  static func pasteboard(_ items: [NSDraggingItem]) -> NSPasteboard? {
    let writers = items.compactMap { $0.item as? NSPasteboardWriting }
    guard !writers.isEmpty, writers.count == items.count else { return nil }
    let board = NSPasteboard.withUniqueName()
    guard board.writeObjects(writers) else { board.releaseGlobally(); return nil }
    return board
  }
}

// AppKit's drag destination API accepts this protocol. The acceptance hook supplies real native pasteboard data,
// then Chromium itself creates DOM drag/drop events and File objects in the renderer.
final class LocalFileTestDraggingInfo: NSObject, NSDraggingInfo {
  let draggingDestinationWindow: NSWindow?
  let draggingPasteboard: NSPasteboard
  let draggingLocation: NSPoint
  let draggingSource: Any?
  let draggingSequenceNumber = Int(ProcessInfo.processInfo.systemUptime * 1000)
  let draggingSourceOperationMask: NSDragOperation = .copy
  var draggedImageLocation: NSPoint { draggingLocation }
  var draggedImage: NSImage? { nil }
  var draggingFormation: NSDraggingFormation = .none
  var animatesToDestination = false
  var numberOfValidItemsForDrop: Int
  var springLoadingHighlight: NSSpringLoadingHighlight { .none }
  private let items: [NSDraggingItem]

  init(window: NSWindow?, board: NSPasteboard, point: NSPoint, source: Any?, items: [NSDraggingItem]) {
    draggingDestinationWindow = window
    draggingPasteboard = board
    draggingLocation = point
    draggingSource = source
    self.items = items
    numberOfValidItemsForDrop = items.count
  }

  func slideDraggedImage(to screenPoint: NSPoint) {}
  override func namesOfPromisedFilesDropped(atDestination dropDestination: URL) -> [String]? { nil }
  func resetSpringLoading() {}
  func enumerateDraggingItems(
    options: NSDraggingItemEnumerationOptions = [], for view: NSView?, classes classArray: [AnyClass],
    searchOptions: [NSPasteboard.ReadingOptionKey: Any] = [:],
    using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void
  ) {
    var stop: ObjCBool = false
    for (index, item) in items.enumerated() {
      block(item, index, &stop)
      if stop.boolValue { break }
    }
  }
}

enum LocalFileAcceptance {
  private static var enabled: Bool { ProcessInfo.processInfo.environment["BAY_BACKGROUND"] == "1" }

  private static func descendants(_ view: NSView) -> [NSView] {
    guard !view.isHidden, view.alphaValue > 0 else { return [] }
    return [view] + view.subviews.flatMap(descendants)
  }

  static func drop(_ windowId: String, _ paths: [String]) -> [String: Any] {
    guard enabled else { return ["error": "test instances only"] }
    guard let window = WindowManager.shared.windows[windowId], let root = window.contentView,
          let destination = descendants(root).compactMap({ $0 as? LocalFilesArea }).first(where: { $0.dropEnabled })
    else { return ["error": "no mounted Finder drop destination"] }
    guard !paths.isEmpty, paths.allSatisfy({ $0.hasPrefix("/") }) else { return ["error": "absolute file paths required"] }
    let items = paths.map { NSDraggingItem(pasteboardWriter: NSURL(fileURLWithPath: $0)) }
    guard let board = LocalFileNativeDrag.pasteboard(items) else { return ["error": "cannot write file pasteboard"] }
    defer { board.releaseGlobally() }
    let point = destination.convert(NSPoint(x: destination.bounds.midX, y: destination.bounds.midY), to: nil)
    let info = LocalFileTestDraggingInfo(window: window, board: board, point: point, source: nil, items: items)
    let entered = destination.draggingEntered(info)
    let prepared = destination.prepareForDragOperation(info)
    let performed = !entered.isEmpty && prepared && destination.performDragOperation(info)
    destination.concludeDragOperation(info)
    return ["destinationClass": String(describing: type(of: destination)), "entered": entered.rawValue,
            "prepared": prepared, "performed": performed, "types": board.types?.map(\.rawValue) ?? [], "count": items.count]
  }

  static func upload(_ windowId: String, _ root: String, _ relative: String, _ point: NSPoint, completion: @escaping ([String: Any]) -> Void) {
    guard enabled else { return completion(["error": "test instances only"]) }
    guard let window = WindowManager.shared.windows[windowId], let content = window.contentView,
          let item = LocalFileNativeDrag.item(root, relative), let board = LocalFileNativeDrag.pasteboard([item])
    else { return completion(["error": "window or authorized native file source unavailable"]) }
    let frame = content.superview ?? content
    let location = NSPoint(x: point.x, y: frame.bounds.height - point.y)
    let hit = frame.hitTest(location)
    var chain: [NSView] = []
    var cursor = hit
    while let view = cursor { chain.append(view); cursor = view.superview }
    // WebContentsViewCocoa owns Chromium's drop implementation. Prefer the hit's ancestor; only consider
    // another mounted web-contents view when it actually contains the requested window point.
    let candidates = chain + descendants(content).filter { view in
      view.bounds.contains(view.convert(location, from: nil))
    }
    guard let destination = candidates.first(where: { String(describing: type(of: $0)) == "WebContentsViewCocoa" })
      ?? candidates.first(where: { String(describing: type(of: $0)) == "RenderWidgetHostViewCocoa" })
    else { board.releaseGlobally(); return completion(["error": "no Chromium drop destination", "hitClass": hit.map { String(describing: type(of: $0)) } ?? "nil"]) }
    let source = descendants(content).compactMap { $0 as? LocalFilesArea }.first { $0.rootPath == root && $0.relativePath == relative }
    let info = LocalFileTestDraggingInfo(window: window, board: board, point: location, source: source, items: [item])
    let entered = destination.draggingEntered(info)
    var attempts = 0
    var finish: (() -> Void)?
    finish = {
      attempts += 1
      let updated = destination.draggingUpdated(info)
      // The renderer replies to dragenter/dragover asynchronously. Give its chosen operation time to return.
      if updated.isEmpty, attempts < 12 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { finish?() }
        return
      }
      let prepared = destination.prepareForDragOperation(info)
      let performed = prepared && destination.performDragOperation(info)
      destination.concludeDragOperation(info)
      completion(["destinationClass": String(describing: type(of: destination)), "hitClass": hit.map { String(describing: type(of: $0)) } ?? "nil",
                  "sourceMounted": source != nil, "entered": entered.rawValue, "updated": updated.rawValue,
                  "prepared": prepared, "performed": performed, "types": board.types?.map(\.rawValue) ?? [], "attempts": attempts])
      board.releaseGlobally()
      finish = nil
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { finish?() }
  }
}
