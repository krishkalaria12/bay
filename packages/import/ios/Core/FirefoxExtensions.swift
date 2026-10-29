import CryptoKit
import Foundation

/// Firefox packages are converted into owned Chromium copies. Source XPIs are never modified.
public enum FirefoxExtensions {
  public enum PreparationError: Error, LocalizedError {
    case unavailable, unsafeArchive, unsupported([String])

    public var errorDescription: String? {
      switch self {
      case .unavailable: return "The source Firefox add-on package is unavailable."
      case .unsafeArchive: return "The Firefox add-on package contains an unsafe archive entry."
      case .unsupported(let reasons): return reasons.joined(separator: " ")
      }
    }
  }

  public static func list(profile: URL) -> [ImportedExtension] {
    addons(profile: profile).map { addon in
      let id = addon["id"] as? String ?? ""
      let path = package(addon: addon, profile: profile)
      let assessment: [String]
      if let path {
        do {
          let files = try contents(path)
          _ = try FirefoxExtensionAdapter.convert(files: files, id: id)
          assessment = []
        } catch PreparationError.unsupported(let reasons) {
          assessment = reasons
        } catch {
          assessment = [error.localizedDescription]
        }
      } else {
        assessment = ["The source Firefox add-on package is unavailable or outside its profile."]
      }
      var result = ImportedExtension(
        id: id,
        name: (addon["defaultLocale"] as? [String: Any])?["name"] as? String ?? addon["name"] as? String ?? id,
        path: path?.path,
        enabled: addon["active"] as? Bool == true && addon["userDisabled"] as? Bool != true && addon["appDisabled"] as? Bool != true
      )
      result.source = "firefox"
      result.destinationId = destinationId(id)
      result.updateMode = "local"
      result.warnings = ["Firefox compatibility uses conservative static checks; extension behavior still needs verification.", "Converted Firefox add-ons are local copies without automatic Firefox updates.", "Firefox extension settings and saved extension data are not migrated."]
      result.compatibility = ImportedExtensionCompatibility(status: assessment.isEmpty ? "compatible" : "unsupported", reasons: assessment)
      return result
    }.sorted {
      let order = $0.name.localizedCaseInsensitiveCompare($1.name)
      return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
    }
  }

  public static func prepare(profile: URL, id: String, directory: URL) throws -> URL {
    guard let addon = addons(profile: profile).first(where: { $0["id"] as? String == id }),
          let source = package(addon: addon, profile: profile) else { throw PreparationError.unavailable }
    let files = try FirefoxExtensionAdapter.convert(files: contents(source), id: id)
    let destination = directory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    let manager = FileManager.default
    try manager.createDirectory(at: directory, withIntermediateDirectories: true)
    do {
      try manager.createDirectory(at: destination, withIntermediateDirectories: false)
      for (name, data) in files {
        let target = destination.appendingPathComponent(name)
        try manager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: target, options: .atomic)
      }
      return destination
    } catch {
      try? manager.removeItem(at: destination)
      throw error
    }
  }

  public static func destinationId(_ addonId: String) -> String {
    let alphabet = Array("abcdefghijklmnop")
    return String(SHA256.hash(data: identityKey(addonId)).prefix(16).flatMap {
      [alphabet[Int($0 >> 4)], alphabet[Int($0 & 15)]]
    })
  }

  static func identityKey(_ addonId: String) -> Data {
    // Ed25519 SPKI. The deterministic seed is an identity namespace, not an installation signing secret.
    let seed = Data(SHA256.hash(data: Data(("bay.firefox-extension.v1:" + addonId).utf8)))
    let key = try! Curve25519.Signing.PrivateKey(rawRepresentation: seed).publicKey.rawRepresentation
    return Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]) + key
  }

  /// Whether `list` would have anything, from the add-on registry alone: discovery asks for every profile, and
  /// `list` unpacks and converts each package.
  public static func hasAddons(profile: URL) -> Bool {
    !addons(profile: profile).isEmpty
  }

  private static func addons(profile: URL) -> [[String: Any]] {
    guard let data = try? Data(contentsOf: profile.appendingPathComponent("extensions.json")),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let addons = root["addons"] as? [[String: Any]] else { return [] }
    var seen: Set<String> = []
    return addons.filter {
      guard let id = $0["id"] as? String, !id.isEmpty, seen.insert(id).inserted,
            $0["type"] as? String == "extension", $0["location"] as? String == "app-profile",
            $0["isSystem"] as? Bool != true, $0["hidden"] as? Bool != true else { return false }
      return true
    }
  }

  private static func package(addon: [String: Any], profile: URL) -> URL? {
    guard let raw = addon["path"] as? String, !raw.isEmpty else { return nil }
    let source = (raw.hasPrefix("/") ? URL(fileURLWithPath: raw) : profile.appendingPathComponent(raw)).standardizedFileURL
    let root = profile.appendingPathComponent("extensions").standardizedFileURL
    guard source.path.hasPrefix(root.path + "/"), source.pathExtension.lowercased() == "xpi",
          source.resolvingSymlinksInPath().path.hasPrefix(root.resolvingSymlinksInPath().path + "/"),
          root.resolvingSymlinksInPath().path.hasPrefix(profile.resolvingSymlinksInPath().path + "/") else { return nil }
    var ancestor = source
    while ancestor.path != profile.standardizedFileURL.path && ancestor.path != "/" {
      guard let values = try? ancestor.resourceValues(forKeys: [.isSymbolicLinkKey]), values.isSymbolicLink != true else { return nil }
      ancestor.deleteLastPathComponent()
    }
    guard (try? source.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { return nil }
    return source
  }

  private static func contents(_ source: URL) throws -> [String: Data] {
    guard let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 64 * 1024 * 1024 else {
      throw PreparationError.unsafeArchive
    }
    let data = try Data(contentsOf: source)
    let archive = try ZipArchive(data)
    guard archive.entries.count <= 8192 else { throw PreparationError.unsafeArchive }
    // ZipArchive exposes decompression, but deliberately not filesystem extraction. Check central
    // attributes here as well so Unix links and special files cannot masquerade as regular JS files.
    try validateCentralDirectory(data)
    var files: [String: Data] = [:]
    var seen: Set<String> = []
    var total = 0
    for entry in archive.entries {
      guard safePath(entry.name), seen.insert(entry.name.decomposedStringWithCanonicalMapping.lowercased()).inserted,
            entry.size <= 32 * 1024 * 1024 else { throw PreparationError.unsafeArchive }
      total += entry.size
      guard total <= 128 * 1024 * 1024 else { throw PreparationError.unsafeArchive }
      if entry.name.hasSuffix("/") { continue }
      let body = try archive.extract(entry)
      guard body.count == entry.size else { throw PreparationError.unsafeArchive }
      if !entry.name.uppercased().hasPrefix("META-INF/") { files[entry.name] = body }
    }
    // Reject ambiguous file/directory collisions before any destination writes.
    for name in files.keys {
      var parent = (name as NSString).deletingLastPathComponent
      while !parent.isEmpty {
        guard files.keys.first(where: { $0.decomposedStringWithCanonicalMapping.lowercased() == parent.decomposedStringWithCanonicalMapping.lowercased() }) == nil else { throw PreparationError.unsafeArchive }
        parent = (parent as NSString).deletingLastPathComponent
      }
    }
    return files
  }

  static func safePath(_ name: String) -> Bool {
    guard !name.isEmpty, !name.hasPrefix("/"), !name.contains("\\"), !name.contains(":"), !name.contains("\0") else { return false }
    let parts = name.split(separator: "/", omittingEmptySubsequences: false)
    return parts.enumerated().allSatisfy { index, part in
      part != "." && part != ".." && (!part.isEmpty || index == parts.count - 1)
    }
  }

  private static func validateCentralDirectory(_ data: Data) throws {
    func u16(_ i: Int) -> UInt16 { UInt16(data[i]) | UInt16(data[i + 1]) << 8 }
    func u32(_ i: Int) -> UInt32 { UInt32(u16(i)) | UInt32(u16(i + 2)) << 16 }
    guard data.count >= 22 else { throw PreparationError.unsafeArchive }
    var end: Int?
    for i in stride(from: data.count - 22, through: max(0, data.count - 22 - 65535), by: -1) {
      if u32(i) == 0x06054b50 && i + 22 + Int(u16(i + 20)) == data.count { end = i; break }
    }
    guard let end, u16(end + 4) == 0, u16(end + 6) == 0, u16(end + 8) == u16(end + 10),
          u16(end + 10) != 65535 else { throw PreparationError.unsafeArchive }
    var offset = Int(u32(end + 16))
    let directoryEnd = offset + Int(u32(end + 12))
    guard directoryEnd == end else { throw PreparationError.unsafeArchive }
    for _ in 0..<u16(end + 10) {
      guard offset + 46 <= end, u32(offset) == 0x02014b50 else { throw PreparationError.unsafeArchive }
      let flags = u16(offset + 8)
      let mode = u32(offset + 38) >> 16
      let type = mode & 0xf000
      guard flags & 1 == 0, type == 0 || type == 0x8000 || type == 0x4000,
            u16(offset + 34) == 0 else { throw PreparationError.unsafeArchive }
      offset += 46 + Int(u16(offset + 28)) + Int(u16(offset + 30)) + Int(u16(offset + 32))
      guard offset <= end else { throw PreparationError.unsafeArchive }
    }
    guard offset == directoryEnd else { throw PreparationError.unsafeArchive }
  }
}
