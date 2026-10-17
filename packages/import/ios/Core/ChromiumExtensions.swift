import Foundation
import CryptoKit

public struct ImportedExtension: Codable, Equatable, Sendable {
  public var id: String
  public var name: String
  public var webStoreUrl: String?
  public var path: String? = nil
  public var enabled: Bool = true
  public var pinned: Bool = false
  public var source: String = "chromium"
  public var compatibility: ImportedExtensionCompatibility? = nil
  public var destinationId: String? = nil
  public var updateMode: String? = nil
  public var warnings: [String] = []
}

public struct ImportedExtensionCompatibility: Codable, Equatable, Sendable {
  public var status: String
  public var reasons: [String]

  public init(status: String, reasons: [String] = []) {
    self.status = status
    self.reasons = reasons
  }
}

public enum ChromiumExtensions {
  public enum PreparationError: Error, CustomStringConvertible, LocalizedError {
    case extensionUnavailable
    case invalidManifest
    case invalidIdentity
    case unsafePath

    public var errorDescription: String? { description }

    public var description: String {
      switch self {
      case .extensionUnavailable: return "The source extension files are unavailable."
      case .invalidManifest: return "The source extension has an invalid or unsupported manifest."
      case .invalidIdentity: return "The source extension identity could not be preserved. Add this extension from the Chrome Web Store instead."
      case .unsafePath: return "The source extension contains an unsafe path or symbolic link."
      }
    }
  }

  public static func list(profile: URL) -> [ImportedExtension] {
    let preferences = preferences(profile: profile)
    var out: [ImportedExtension] = []
    for (id, value) in preferences.settings {
      guard isExtensionId(id), let entry = value as? [String: Any],
            [1, 4].contains(entry["location"] as? Int ?? 1) else { continue }
      let folder = extensionDirectory(id: id, entry: entry, profile: profile)
      let manifest = readJSON(folder?.appendingPathComponent("manifest.json")) ?? entry["manifest"] as? [String: Any]
      guard let manifest, manifest["theme"] == nil, manifest["app"] == nil else { continue }
      let store = entry["from_webstore"] as? Bool == true
      out.append(ImportedExtension(
        id: id, name: name(manifest: manifest, directory: folder) ?? id,
        webStoreUrl: store ? "https://chromewebstore.google.com/detail/\(id)" : nil,
        path: folder?.path, enabled: isEnabled(entry), pinned: preferences.pinned.contains(id)
      ))
    }
    return out.sorted {
      let order = $0.name.localizedCaseInsensitiveCompare($1.name)
      return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
    }
  }

  // Keep an owned copy: browser upgrades or profile removal must not break an import.
  public static func prepare(profile: URL, id: String, directory: URL) throws -> URL {
    guard let selected = list(profile: profile).first(where: { $0.id == id }),
          let path = selected.path else { throw PreparationError.extensionUnavailable }
    let source = URL(fileURLWithPath: path, isDirectory: true)
    let entry = preferences(profile: profile).settings[id] as? [String: Any]
    try rejectSymbolicLinks(in: source, through: entry?["location"] as? Int == 4 ? nil : profile)
    guard var manifest = readJSON(source.appendingPathComponent("manifest.json")),
          let name = manifest["name"] as? String, !name.isEmpty,
          let version = manifest["version"] as? String, !version.isEmpty,
          let manifestVersion = manifest["manifest_version"] as? Int,
          [2, 3].contains(manifestVersion), manifest["theme"] == nil, manifest["app"] == nil else {
      throw PreparationError.invalidManifest
    }
    if manifest["key"] == nil,
       let storedManifest = entry?["manifest"] as? [String: Any], let key = storedManifest["key"] as? String {
      manifest["key"] = key
    }
    if let encodedKey = manifest["key"] as? String {
      guard let key = Data(base64Encoded: encodedKey), !key.isEmpty else { throw PreparationError.invalidIdentity }
      let alphabet = Array("abcdefghijklmnop")
      let keyID = String(SHA256.hash(data: key).prefix(16).flatMap { byte in
        [alphabet[Int(byte >> 4)], alphabet[Int(byte & 0x0f)]]
      })
      guard keyID == id else { throw PreparationError.invalidIdentity }
    } else if manifest["key"] != nil || selected.webStoreUrl != nil {
      throw PreparationError.invalidIdentity
    }
    let manager = FileManager.default
    let destination = directory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    // A destination inside the source would make recursive copying unsafe.
    guard !isWithin(destination.resolvingSymlinksInPath(), source.resolvingSymlinksInPath()) else {
      throw PreparationError.unsafePath
    }
    try manager.createDirectory(at: directory, withIntermediateDirectories: true)
    do {
      try manager.copyItem(at: source, to: destination)
      let metadata = destination.appendingPathComponent("_metadata", isDirectory: true)
      if manager.fileExists(atPath: metadata.path) { try manager.removeItem(at: metadata) }
      let data = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
      try data.write(to: destination.appendingPathComponent("manifest.json"), options: .atomic)
      return destination
    } catch {
      try? manager.removeItem(at: destination)
      throw error
    }
  }

  static func isExtensionId(_ id: String) -> Bool {
    id.count == 32 && id.allSatisfy { ("a"..."p").contains($0) }
  }

  private static func preferences(profile: URL) -> (settings: [String: Any], pinned: Set<String>) {
    var settings: [String: Any] = [:]
    var pinned: Set<String> = []
    for file in ["Preferences", "Secure Preferences"] {
      guard let root = readJSON(profile.appendingPathComponent(file)),
            let extensions = root["extensions"] as? [String: Any] else { continue }
      pinned.formUnion(extensions["pinned_extensions"] as? [String] ?? [])
      settings.merge(extensions["settings"] as? [String: Any] ?? [:]) { old, new in
        guard var a = old as? [String: Any], let b = new as? [String: Any] else { return new }
        a.merge(b) { $1 }
        return a
      }
    }
    return (settings, pinned)
  }

  private static func readJSON(_ url: URL?) -> [String: Any]? {
    guard let url, let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  }

  private static func extensionDirectory(id: String, entry: [String: Any], profile: URL) -> URL? {
    let root = profile.appendingPathComponent("Extensions", isDirectory: true).standardizedFileURL
    let idRoot = root.appendingPathComponent(id, isDirectory: true)
    if entry["location"] as? Int != 4 {
      guard isWithin(root.resolvingSymlinksInPath(), profile.resolvingSymlinksInPath()) else { return nil }
    }
    if let path = entry["path"] as? String, !path.isEmpty {
      let unpacked = entry["location"] as? Int == 4
      if unpacked && !path.hasPrefix("/") { return nil }
      let folder = (path.hasPrefix("/") ? URL(fileURLWithPath: path, isDirectory: true) :
        root.appendingPathComponent(path, isDirectory: true)).standardizedFileURL
      if !unpacked {
        guard isWithin(folder, idRoot),
              isWithin(folder.resolvingSymlinksInPath(), idRoot.resolvingSymlinksInPath()),
              isWithin(folder.resolvingSymlinksInPath(), root.resolvingSymlinksInPath()) else { return nil }
      }
      var isDirectory: ObjCBool = false
      guard FileManager.default.fileExists(atPath: folder.path, isDirectory: &isDirectory), isDirectory.boolValue else { return nil }
      return folder
    }
    guard entry["location"] as? Int != 4,
          let folders = try? FileManager.default.contentsOfDirectory(at: idRoot, includingPropertiesForKeys: [.isDirectoryKey]) else { return nil }
    let version = (entry["manifest"] as? [String: Any])?["version"] as? String
    return folders.filter {
      isWithin($0.resolvingSymlinksInPath(), root.resolvingSymlinksInPath()) &&
        (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true &&
        readJSON($0.appendingPathComponent("manifest.json")) != nil
    }.sorted {
      if let version {
        let a = $0.lastPathComponent.components(separatedBy: "_").first == version
        let b = $1.lastPathComponent.components(separatedBy: "_").first == version
        if a != b { return a }
      }
      return $0.lastPathComponent.compare($1.lastPathComponent, options: .numeric) == .orderedDescending
    }.first
  }

  private static func isWithin(_ path: URL, _ parent: URL) -> Bool {
    let root = parent.standardizedFileURL.path
    let candidate = path.standardizedFileURL.path
    return candidate == root || candidate.hasPrefix(root + "/")
  }

  private static func isEnabled(_ entry: [String: Any]) -> Bool {
    if let state = entry["state"] as? Int, state != 1 { return false }
    if let reasons = entry["disable_reasons"] as? Int, reasons != 0 { return false }
    if let reasons = entry["disable_reasons"] as? [Any], !reasons.isEmpty { return false }
    return true
  }

  private static func name(manifest: [String: Any], directory: URL?) -> String? {
    guard let raw = (manifest["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
    guard raw.hasPrefix("__MSG_"), raw.hasSuffix("__") else { return raw }
    let key = String(raw.dropFirst(6).dropLast(2)).lowercased()
    guard let directory, let locale = manifest["default_locale"] as? String,
          !locale.isEmpty, !locale.contains("/"), !locale.contains("\\"), locale != ".", locale != ".." else { return nil }
    let url = directory.appendingPathComponent("_locales/\(locale)/messages.json")
    guard isWithin(url.resolvingSymlinksInPath(), directory.resolvingSymlinksInPath()),
          let messages = readJSON(url) else { return nil }
    let match = messages.first { $0.key.lowercased() == key }?.value as? [String: Any]
    return (match?["message"] as? String).flatMap { $0.isEmpty ? nil : $0 }
  }

  private static func rejectSymbolicLinks(in directory: URL, through profile: URL?) throws {
    let manager = FileManager.default
    var ancestor = directory.standardizedFileURL
    let profilePath = profile?.resolvingSymlinksInPath().path
    while ancestor.path != "/" {
      if try ancestor.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true {
        throw PreparationError.unsafePath
      }
      if profilePath == nil { break }
      ancestor.deleteLastPathComponent()
      if ancestor.resolvingSymlinksInPath().path == profilePath { break }
    }
    var enumerationError: Error?
    guard let enumerator = manager.enumerator(at: directory, includingPropertiesForKeys: [.isSymbolicLinkKey],
                                               options: [], errorHandler: { _, error in
      enumerationError = error
      return false
    }) else {
      throw PreparationError.extensionUnavailable
    }
    for case let file as URL in enumerator {
      if try file.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true {
        throw PreparationError.unsafePath
      }
    }
    if let enumerationError { throw enumerationError }
  }
}
