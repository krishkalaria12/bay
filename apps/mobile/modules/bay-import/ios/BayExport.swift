import Foundation

/// What `readExport` returns: the files Bay reads, copied out of the archive, and the names of the rest.
enum BayExport {
  /// The largest file Bay unpacks: a year of Takeout history is a few tens of megabytes.
  static let maxFileSize = 64 * 1024 * 1024
  static let maxFiles = 64
  /// How many names of left-out files are reported: enough to tell what an archive held.
  static let maxSkipped = 200

  static var folder: URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("bay-import", isDirectory: true)
  }

  static func discard() {
    try? FileManager.default.removeItem(at: folder)
  }

  /// Whether an archive entry is one Bay reads: a bookmarks page, or a history file by its name.
  static func wanted(_ name: String) -> Bool {
    let lower = name.lowercased()
    let ext = (lower as NSString).pathExtension
    if ext == "html" || ext == "htm" { return true }
    guard ext == "json" else { return false }
    let squashed = lower.replacingOccurrences(of: "[ _-]", with: "", options: .regularExpression)
    return squashed.hasPrefix("history") || squashed.hasPrefix("browserhistory")
  }

  static func read(_ path: String) throws -> [String: Any] {
    let source = path.hasPrefix("file://") ? (URL(string: path) ?? URL(fileURLWithPath: path)) : URL(fileURLWithPath: path)
    guard FileManager.default.fileExists(atPath: source.path) else { throw BayZipError.unreadable("The file isn't there any more") }

    // A single file (a bookmarks page, a history file) is read where it is.
    guard BayZip.isZip(source) else {
      let size = (try? source.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
      if size > maxFileSize { return ["files": [], "skipped": [], "tooLarge": [source.lastPathComponent]] }
      return ["files": [["name": source.lastPathComponent, "path": source.path]], "skipped": [], "tooLarge": []]
    }

    discard()
    let destination = folder.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)

    let zip = try BayZip(source)
    var files: [[String: Any]] = []
    var skipped: [String] = []
    var tooLarge: [String] = []

    for entry in zip.entries where !entry.path.hasSuffix("/") && !entry.path.hasPrefix("__MACOSX/") {
      let name = (entry.path as NSString).lastPathComponent
      if name.isEmpty || name.hasPrefix(".") { continue }
      guard wanted(name) else {
        if skipped.count < maxSkipped { skipped.append(name) }
        continue
      }
      guard entry.size <= maxFileSize, files.count < maxFiles else { tooLarge.append(name); continue }
      let target = destination.appendingPathComponent("\(files.count)-\(name)")
      try zip.extract(entry).write(to: target)
      files.append(["name": name, "path": target.path])
    }

    return ["files": files, "skipped": skipped, "tooLarge": tooLarge]
  }
}
