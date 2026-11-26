import AppKit
import ExpoModulesCore

// Folders that stay shared (apps/browser lib/sharedFolders.ts): a pinned folder bound to a real folder of link files,
// by default in iCloud Drive › Bay Shared, which the share sheet's Collaborate shares with other people (Dropbox or
// any synced folder works too). Windows and Linux have the same calls (engine webui/shared_folders.cc).
//
// A folder is reachable only once the person picked it here; the grants live in shared-folders.plist. Inside one the
// app reads, writes and removes link files by name only. Reads and writes are coordinated, as iCloud Drive wants; a
// removed link goes to the Trash. A binary .webloc (what Finder writes) is read back as its XML.

private let sharedFolderQueue = DispatchQueue(label: "bay.shared-folders", qos: .userInitiated)
private let linkExtensions: Set<String> = ["webloc", "url", "desktop"]
private let maxLinkFile = 64 * 1024

final class SharedFolderGrants {
  static let shared = SharedFolderGrants()
  private var paths: Set<String> = []
  private let lock = NSLock()

  private init() {
    if let url = try? ShellModule.documentURL("shared-folders.plist"), let data = try? Data(contentsOf: url),
       let saved = try? PropertyListDecoder().decode([String].self, from: data) {
      paths = Set(saved)
    }
  }

  private func save() throws {
    let url = try ShellModule.documentURL("shared-folders.plist")
    try PropertyListEncoder().encode(paths.sorted()).write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }

  /// Only with URLs from AppKit's folder picker, never a path from JS.
  func grant(_ url: URL) throws -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    let url = url.standardizedFileURL
    guard (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { throw CocoaError(.fileReadInvalidFileName) }
    paths.insert(url.path)
    try save()
    return ["path": url.path, "name": url.lastPathComponent]
  }

  func forget(_ path: String) {
    lock.lock()
    defer { lock.unlock() }
    if paths.remove(path) != nil { try? save() }
  }

  /// The granted folder at `path`, if it is one.
  func folder(_ path: String) -> URL? {
    lock.lock()
    defer { lock.unlock() }
    return paths.contains(path) ? URL(fileURLWithPath: path, isDirectory: true) : nil
  }
}

enum SharedFolderFiles {
  static func validName(_ name: String) -> Bool {
    guard !name.isEmpty, name.utf8.count <= 255, !name.hasPrefix("."),
          linkExtensions.contains((name as NSString).pathExtension.lowercased()) else { return false }
    return name.unicodeScalars.allSatisfy { $0.value >= 0x20 && !"/\\:*?\"<>|".unicodeScalars.contains($0) }
  }

  /// A link file's text: as it is, or a binary property list (.webloc) as XML.
  static func text(_ data: Data) -> String? {
    if data.starts(with: Array("bplist".utf8)),
       let plist = try? PropertyListSerialization.propertyList(from: data, format: nil),
       let xml = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0) {
      return String(data: xml, encoding: .utf8)
    }
    return String(data: data, encoding: .utf8)
  }

  static func read(_ path: String) -> [String: Any] {
    guard let folder = SharedFolderGrants.shared.folder(path) else { return ["status": "inaccessible"] }
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: folder.path, isDirectory: &isDirectory), isDirectory.boolValue else { return ["status": "missing"] }
    var entries: [[String: Any]] = []
    var failure: NSError?
    NSFileCoordinator().coordinate(readingItemAt: folder, options: [], error: &failure) { url in
      let keys: [URLResourceKey] = [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey]
      let children = (try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles])) ?? []
      for child in children.prefix(2000) {
        guard validName(child.lastPathComponent), let values = try? child.resourceValues(forKeys: Set(keys)),
              values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? 0) <= maxLinkFile,
              let data = try? Data(contentsOf: child), let text = text(data) else { continue }
        entries.append(["name": child.lastPathComponent, "text": text,
                        "modified": (values.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000])
      }
    }
    return failure == nil ? ["status": "available", "entries": entries] : ["status": "inaccessible"]
  }

  static func write(_ path: String, _ name: String, _ text: String) -> Bool {
    guard let folder = SharedFolderGrants.shared.folder(path), validName(name), text.utf8.count <= maxLinkFile else { return false }
    let target = folder.appendingPathComponent(name)
    var ok = false
    var failure: NSError?
    NSFileCoordinator().coordinate(writingItemAt: target, options: .forReplacing, error: &failure) { url in
      ok = (try? Data(text.utf8).write(to: url, options: .atomic)) != nil
    }
    return ok && failure == nil
  }

  static func remove(_ path: String, _ name: String) -> Bool {
    guard let folder = SharedFolderGrants.shared.folder(path), validName(name) else { return false }
    let target = folder.appendingPathComponent(name)
    guard FileManager.default.fileExists(atPath: target.path) else { return true }
    var ok = false
    var failure: NSError?
    NSFileCoordinator().coordinate(writingItemAt: target, options: .forDeleting, error: &failure) { url in
      ok = (try? FileManager.default.trashItem(at: url, resultingItemURL: nil)) != nil
    }
    return ok && failure == nil
  }
}

public class SharedFoldersModule: Module {
  private var watchers: [String: DispatchSourceFileSystemObject] = [:]

  /// iCloud Drive › Bay Shared when iCloud Drive is on (made if it's missing), else the home folder.
  private static func suggestedFolder() -> URL {
    let iCloud = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Mobile Documents/com~apple~CloudDocs")
    guard FileManager.default.fileExists(atPath: iCloud.path) else { return FileManager.default.homeDirectoryForCurrentUser }
    let bay = iCloud.appendingPathComponent("Bay Shared")
    try? FileManager.default.createDirectory(at: bay, withIntermediateDirectories: true)
    return bay
  }

  private func watch(_ path: String, _ on: Bool) {
    watchers.removeValue(forKey: path)?.cancel()
    guard on, let folder = SharedFolderGrants.shared.folder(path) else { return }
    let fd = open(folder.path, O_EVTONLY)
    guard fd >= 0 else { return }
    let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .delete, .rename, .extend], queue: sharedFolderQueue)
    source.setEventHandler { [weak self] in self?.sendEvent("onChange", ["path": path]) }
    source.setCancelHandler { close(fd) }
    watchers[path] = source
    source.resume()
  }

  public func definition() -> ModuleDefinition {
    Name("BaySharedFolders")
    Events("onChange")

    OnDestroy {
      for source in self.watchers.values { source.cancel() }
      self.watchers.removeAll()
    }

    AsyncFunction("pick") { (promise: Promise) in
      let panel = NSOpenPanel()
      panel.canChooseFiles = false
      panel.canChooseDirectories = true
      panel.canCreateDirectories = true
      panel.allowsMultipleSelection = false
      panel.message = "Choose a folder to keep this folder's links in. Anyone you share it with sees the same links."
      panel.prompt = "Choose"
      panel.directoryURL = Self.suggestedFolder()
      panel.begin { result in
        guard result == .OK, let url = panel.url else { return promise.resolve(nil) }
        do { promise.resolve(try SharedFolderGrants.shared.grant(url)) }
        catch { promise.reject("ERR_SHARED_FOLDER", error.localizedDescription) }
      }
    }.runOnQueue(.main)

    AsyncFunction("read") { (path: String) -> [String: Any] in SharedFolderFiles.read(path) }.runOnQueue(sharedFolderQueue)
    AsyncFunction("write") { (path: String, name: String, text: String) -> Bool in SharedFolderFiles.write(path, name, text) }.runOnQueue(sharedFolderQueue)
    AsyncFunction("remove") { (path: String, name: String) -> Bool in SharedFolderFiles.remove(path, name) }.runOnQueue(sharedFolderQueue)
    AsyncFunction("watch") { (path: String, on: Bool) in self.watch(path, on) }.runOnQueue(sharedFolderQueue)

    AsyncFunction("forget") { (path: String) in
      self.watch(path, false)
      SharedFolderGrants.shared.forget(path)
    }.runOnQueue(sharedFolderQueue)

    AsyncFunction("reveal") { (path: String) -> Bool in
      guard let folder = SharedFolderGrants.shared.folder(path) else { return false }
      NSWorkspace.shared.activateFileViewerSelecting([folder])
      return true
    }.runOnQueue(.main)

    // The share sheet for the folder, where iCloud Drive's Collaborate invites people to it.
    AsyncFunction("share") { (path: String) -> Bool in
      guard let folder = SharedFolderGrants.shared.folder(path),
            let view = NSApp.keyWindow?.contentView ?? NSApp.mainWindow?.contentView else { return false }
      let picker = NSSharingServicePicker(items: [folder])
      let anchor = NSRect(x: view.bounds.midX - 1, y: view.bounds.maxY - 80, width: 2, height: 2)
      picker.show(relativeTo: anchor, of: view, preferredEdge: .minY)
      return true
    }.runOnQueue(.main)
  }
}
