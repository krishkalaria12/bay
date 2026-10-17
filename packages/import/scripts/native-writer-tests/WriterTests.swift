import Foundation
import BayNNCore

@main
struct WriterTests {
  @MainActor
  static func main() async throws {
    let fm = FileManager.default
    let sandbox = fm.temporaryDirectory.appendingPathComponent("extension-writer-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: sandbox) }
    let support = sandbox.appendingPathComponent("Support")
    let source = support.appendingPathComponent("Google/Chrome/Default")
    let destination = sandbox.appendingPathComponent("Chromium")
    try fm.createDirectory(at: source, withIntermediateDirectories: true)
    let importer = Importer(discovery: BrowserDiscovery(applicationSupport: support))
    let id = String(repeating: "a", count: 32)
    let manifest: [String: Any] = ["name": "Test", "version": "1.0", "manifest_version": 3]
    func preferences(store: Bool) throws {
      let entry: [String: Any] = ["manifest": manifest, "from_webstore": store, "location": 1, "state": 0]
      let data = try JSONSerialization.data(withJSONObject: ["extensions": ["settings": [id: entry], "pinned_extensions": [id]]])
      try data.write(to: source.appendingPathComponent("Preferences"))
    }
    func configure(_ reply: [String: Any], capable: Bool = true, referenced: Bool = false, listFails: Bool = false) {
      ImportMockConfigure(destination.path, capable, reply, referenced, listFails)
    }
    func write(_ profile: String = "work") async throws -> ExtensionImportWriter.Reply {
      try await ExtensionImportWriter.write(importer: importer, browserId: "chrome", sourceProfile: "Default", id: id, profile: profile)
    }
    func args() -> [String: Any] { ImportMockArgs() as! [String: Any] }
    func preparedExists() -> Bool { (args()["path"] as? String).map { fm.fileExists(atPath: $0) } ?? false }
    func mustFail(_ operation: () async throws -> Void) async throws {
      do { try await operation() } catch { return }
      fatalError("expected a failure")
    }
    let successful: [String: Any] = ["id": id, "installed": true, "storageImported": 4, "warnings": ["one"], "updateMode": "store"]

    // Store identity comes from source metadata, even when source installation files are gone.
    try preferences(store: true)
    configure(successful)
    let store = try await write()
    precondition(store.storageImported == 4 && store.warnings == ["one"] && store.updateMode == "store")
    let storeEvent = ImportMockEvent() as! [String: Any]
    precondition(storeEvent["name"] as? String == "changed")
    precondition((storeEvent["payload"] as? [String: String]) == ["profile": "work", "id": id, "event": "installed"])
    precondition(args()["id"] as? String == id && args()["path"] == nil)
    precondition(args()["sourceProfilePath"] as? String == source.path)
    precondition(args()["source"] as? String == "chromium")
    precondition(args()["enabled"] as? Bool == false && args()["pinned"] as? Bool == true)
    precondition(!fm.fileExists(atPath: destination.path))

    // Keeping an already installed local copy must not imply that its store updater was restored.
    configure(["id": id, "installed": false, "storageImported": 0, "warnings": [], "updateMode": "local"])
    let existingLocal = try await write()
    precondition(!existingLocal.installed && existingLocal.updateMode == "local")
    precondition(existingLocal.warnings == ["Kept the existing local extension installation. Automatic updates are unavailable."])
    precondition(existingLocal.storageImported == 0 && args()["path"] == nil)
    precondition(!fm.fileExists(atPath: destination.path))

    // An old engine fails before any local copy or install call.
    try preferences(store: false)
    configure(successful, capable: false)
    try await mustFail { _ = try await write() }
    precondition(ImportMockCalls() == 0 && !fm.fileExists(atPath: destination.path))

    let installed = source.appendingPathComponent("Extensions/\(id)/1.0_0")
    try fm.createDirectory(at: installed, withIntermediateDirectories: true)
    try JSONSerialization.data(withJSONObject: manifest).write(to: installed.appendingPathComponent("manifest.json"))
    var localSuccess = successful
    localSuccess["updateMode"] = "local"
    let localWarning = "Imported as a local extension. Automatic updates are unavailable."
    localSuccess["warnings"] = ["one", localWarning]
    configure(localSuccess)
    let local = try await write()
    precondition(local.installed && preparedExists())
    precondition(local.warnings == ["one", localWarning])
    precondition((args()["path"] as? String)?.hasPrefix(destination.appendingPathComponent("Profile work/Imported Extensions/\(id)").path + "/") == true)

    // Retrying an existing installation discards only its unused new snapshot.
    let retained = args()["path"] as! String
    var skipped = localSuccess
    skipped["installed"] = false
    configure(skipped)
    let retry = try await write()
    precondition(!retry.installed && !preparedExists() && fm.fileExists(atPath: retained))
    precondition((ImportMockEvent()["payload"] as? [String: String])?["event"] == "configured")

    // Fresh off-store imports report their update limitation even when the engine omits a notice.
    var silentLocal = localSuccess
    silentLocal["warnings"] = []
    configure(silentLocal)
    let notified = try await write()
    precondition(notified.warnings == [localWarning])

    // Failed registration removes its owned snapshot; failed rollback keeps a referenced one.
    configure(["error": "installation rejected"])
    try await mustFail { _ = try await write() }
    precondition(!preparedExists())
    precondition(ImportMockEvent().isEmpty)
    configure(["error": "rollback failed", "retainsPath": true])
    try await mustFail { _ = try await write() }
    precondition(preparedExists())
    configure(["error": "ambiguous failure"], referenced: true)
    try await mustFail { _ = try await write() }
    precondition(preparedExists())
    configure(["error": "engine disconnected"], listFails: true)
    try await mustFail { _ = try await write() }
    precondition(preparedExists())

    // Invalid destination names and missing sources never reach the engine.
    configure(successful)
    try await mustFail { _ = try await write("../escape") }
    precondition(ImportMockCalls() == 0)
    try preferences(store: false)
    try fm.removeItem(at: installed)
    try await mustFail { _ = try await write() }
    precondition(ImportMockCalls() == 0)

    // Firefox counterpart selection uses the add-on ID, with a separate verified Chromium destination ID.
    let firefox = support.appendingPathComponent("Firefox/Profiles/test")
    try fm.createDirectory(at: firefox, withIntermediateDirectories: true)
    let firefoxId = "addon@darkreader.org"
    let counterpart = "eimadpbcbfnmbkopoojfekhnkhdbieeh"
    func firefoxAddons(_ addons: [[String: Any]]) throws {
      try JSONSerialization.data(withJSONObject: ["addons": addons]).write(to: firefox.appendingPathComponent("extensions.json"))
    }
    try firefoxAddons([["id": firefoxId, "type": "extension", "location": "app-profile", "active": true]])
    var firefoxReply = successful
    firefoxReply["id"] = counterpart
    firefoxReply["warnings"] = []
    configure(firefoxReply)
    let mapped = try await ExtensionImportWriter.write(importer: importer, browserId: "firefox", sourceProfile: "Profiles/test", id: firefoxId, profile: "firefox-space")
    precondition(mapped.id == counterpart && mapped.warnings.contains { $0.contains("Firefox extension settings aren't migrated") })
    precondition(args()["sourceId"] as? String == firefoxId && args()["id"] as? String == counterpart && args()["path"] == nil)
    precondition(args()["source"] as? String == "firefox")

    // Compatible Firefox-only XPIs reach the same staged engine operation, preserving their stable identity.
    let addonId = "test-compat@example.org"
    let unpacked = firefox.appendingPathComponent("extensions/source")
    try fm.createDirectory(at: unpacked, withIntermediateDirectories: true)
    var firefoxManifest = manifest
    firefoxManifest["browser_specific_settings"] = ["gecko": ["id": addonId]]
    try JSONSerialization.data(withJSONObject: firefoxManifest).write(to: unpacked.appendingPathComponent("manifest.json"))
    let xpi = firefox.appendingPathComponent("extensions/test.xpi")
    let zip = Process()
    zip.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
    zip.currentDirectoryURL = unpacked
    zip.arguments = ["-q", xpi.path, "manifest.json"]
    try zip.run()
    zip.waitUntilExit()
    precondition(zip.terminationStatus == 0)
    try firefoxAddons([["id": addonId, "type": "extension", "location": "app-profile", "active": true, "path": xpi.path]])
    var convertedReply = localSuccess
    convertedReply["id"] = FirefoxExtensions.destinationId(addonId)
    configure(convertedReply)
    let converted = try await ExtensionImportWriter.write(importer: importer, browserId: "firefox", sourceProfile: "Profiles/test", id: addonId, profile: "firefox-space")
    precondition(converted.id == FirefoxExtensions.destinationId(addonId) && preparedExists())
    precondition(args()["sourceId"] as? String == addonId && args()["id"] as? String == converted.id)
    precondition((args()["path"] as? String)?.hasPrefix(destination.appendingPathComponent("Profile firefox-space/Imported Extensions/\(converted.id)").path + "/") == true)
    print("Native extension writer lifecycle checks passed")
  }
}
