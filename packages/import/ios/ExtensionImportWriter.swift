import Foundation
import CryptoKit
import BayNNCore

// The engine owns verification, storage hydration and activation. Local copies remain owned by the destination
// profile because UnpackedInstaller retains their path; store installs own their verified package instead.
enum ExtensionImportWriter {
  struct Reply: Encodable {
    var id: String
    var installed: Bool
    var storageImported: Int
    var warnings: [String]
    var updateMode: String
  }

  @MainActor
  static func write(importer: Importer, browserId: String, sourceProfile: String, id: String, profile: String) async throws -> Reply {
    guard profile.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }),
          let def = BrowserDefinition.find(browserId), def.isChromiumBased || def.family == .firefox else {
      throw ImportError.unsupported("Unknown extension or destination profile")
    }
    guard NNCoreEngineBridge.exports("nn_extensions_import") else {
      throw ImportError.unsupported("This browser engine does not support extension imports. Update the browser engine and try again")
    }
    let source = try importer.discovery.profileDirectory(def, sourceProfile)
    let selection: ImportedExtension = try await withCheckedThrowingContinuation { done in
      DispatchQueue.global(qos: .userInitiated).async {
        guard let info = ExtensionsImport.list(profile: source, browser: def).first(where: { $0.id == id }) else {
          done.resume(throwing: ImportError.notFound("The source extension is no longer installed"))
          return
        }
        done.resume(returning: info)
      }
    }
    let store = selection.webStoreUrl != nil
    var expectedId = selection.destinationId ?? (def.isChromiumBased && store ? id : nil)
    if let expectedId, !ChromiumExtensions.isExtensionId(expectedId) {
      throw ImportError.unsupported("The extension has an invalid destination identity")
    }
    if store {
      guard let expectedId, selection.webStoreUrl == "https://chromewebstore.google.com/detail/\(expectedId)" else {
        throw ImportError.unsupported("The extension does not have a verified Chrome Web Store identity")
      }
    }
    let folderId = expectedId ?? (ChromiumExtensions.isExtensionId(id) ? id :
      SHA256.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined())
    let root = URL(fileURLWithPath: NNCoreHost.dataDirectory, isDirectory: true)
      .appendingPathComponent(profile.isEmpty ? "Default" : "Profile \(profile)", isDirectory: true)
      .appendingPathComponent("Imported Extensions", isDirectory: true)
      .appendingPathComponent(folderId, isDirectory: true)
    var prepared: URL?
    if !store {
      let path: URL = try await withCheckedThrowingContinuation { done in
        DispatchQueue.global(qos: .userInitiated).async {
          do {
            let copied = try def.family == .firefox ?
              FirefoxExtensions.prepare(profile: source, id: id, directory: root) :
              ChromiumExtensions.prepare(profile: source, id: id, directory: root)
            done.resume(returning: copied)
          } catch {
            done.resume(throwing: error)
          }
        }
      }
      prepared = path
      if expectedId == nil {
        expectedId = NNCoreServices.inspectUnpacked(path.path)["id"] as? String
      }
    }
    var args: [String: Any] = [
      "sourceId": id, "sourceProfilePath": source.path, "source": selection.source, "store": store,
      "enabled": selection.enabled, "pinned": selection.pinned,
    ]
    if let expectedId { args["id"] = expectedId }
    if let prepared { args["path"] = prepared.path }
    let result: [String: Any] = await withCheckedContinuation { done in
      NNCoreServices.call("nn_extensions_import", profile: profile, args: args) { done.resume(returning: $0) }
    }
    if let message = result["error"] as? String {
      if let prepared, result["retainsPath"] as? Bool != true,
         await canRemove(prepared, profile: profile) {
        try? FileManager.default.removeItem(at: prepared)
      }
      throw ImportError.unreadable(message)
    }
    guard let installedId = result["id"] as? String, ChromiumExtensions.isExtensionId(installedId),
          let installed = result["installed"] as? Bool,
          let updateMode = result["updateMode"] as? String, ["store", "local"].contains(updateMode) else {
      if let prepared, await canRemove(prepared, profile: profile) {
        try? FileManager.default.removeItem(at: prepared)
      }
      throw ImportError.unreadable("The engine returned an invalid extension import result")
    }
    if !installed, let prepared { try? FileManager.default.removeItem(at: prepared) }
    var warnings = installed ? selection.warnings : []
    for warning in result["warnings"] as? [String] ?? [] where !warnings.contains(warning) {
      warnings.append(warning)
    }
    let localWarning: String?
    if updateMode == "local", store, !installed {
      localWarning = "Kept the existing local extension installation. Automatic updates are unavailable."
    } else if updateMode == "local", installed, selection.source != "firefox" {
      localWarning = "Imported as a local extension. Automatic updates are unavailable."
    } else {
      localWarning = nil
    }
    if let localWarning, !warnings.contains(localWarning) { warnings.append(localWarning) }
    NNCoreServices.extensionsHandler?("changed", ["profile": profile, "id": installedId,
                                                 "event": installed ? "installed" : "configured"])
    return Reply(id: installedId, installed: installed,
                 storageImported: (result["storageImported"] as? NSNumber)?.intValue ?? 0,
                 warnings: warnings, updateMode: updateMode)
  }

  // On ambiguous failures, a retained installation must not lose the files the engine references.
  @MainActor
  private static func canRemove(_ prepared: URL, profile: String) async -> Bool {
    let result: [String: Any] = await withCheckedContinuation { done in
      NNCoreServices.listExtensions(profile: profile) { done.resume(returning: $0) }
    }
    guard result["error"] == nil, let extensions = result["extensions"] as? [[String: Any]] else { return false }
    let path = prepared.standardizedFileURL.path
    return !extensions.contains {
      guard let installedPath = $0["path"] as? String else { return false }
      let installed = URL(fileURLWithPath: installedPath).standardizedFileURL.path
      return installed == path || installed.hasPrefix(path + "/")
    }
  }
}
