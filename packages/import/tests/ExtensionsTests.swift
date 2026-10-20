import XCTest
@testable import BayImportCore

final class ExtensionsTests: XCTestCase {
  func testListsWebStoreExtensionsWithNames() {
    let list = ChromiumExtensions.list(profile: Fixtures.url("extensions/Default"))
    XCTAssertEqual(list.map(\.name), ["Localized Blocker", "Older Chrome Keeps Manifests", "Plain Name"])
    XCTAssertEqual(list.map(\.id), ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"])
    XCTAssertEqual(list.first?.webStoreUrl, "https://chromewebstore.google.com/detail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
  }

  func testMissingProfileListsNothing() {
    XCTAssertEqual(ChromiumExtensions.list(profile: Fixtures.url("extensions/Nope")), [])
  }

  private let firstID = String(repeating: "a", count: 32)
  private let secondID = String(repeating: "b", count: 32)
  // DER-encoded RSA public key and its independently computed Chromium extension ID.
  private let publicKey = "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDx45QYgxFQt3EQt8C7A7k7UPSQ18YnrsLTXlz+pTcWFiFZQHL9jsY57jOpCT9f1Ua91GI9ZofP9rNcXWVoyi6vyX3dgrjNXvMfq97lUBl+s8Ohl3Z4JAtXv9cQ0ojnMzZezvgHQk7cRKU6H2CzY8AIXqTYDvZlSt9+m2rWgyAwSQIDAQAB"
  private let publicKeyID = "liiecdacpeonjdiebgmimlblehpcoodg"

  private func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url.resolvingSymlinksInPath()
  }

  private func write(_ value: [String: Any], to url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONSerialization.data(withJSONObject: value).write(to: url)
  }

  private func extensionFiles(_ profile: URL, id: String, version: String = "1.0_0", name: String = "Example") throws -> URL {
    let folder = profile.appendingPathComponent("Extensions/\(id)/\(version)")
    try write(["name": name, "version": version.components(separatedBy: "_")[0], "manifest_version": 3],
              to: folder.appendingPathComponent("manifest.json"))
    return folder
  }

  func testIncludesUserOffStoreAndUnpackedExtensions() throws {
    let profile = try temporaryDirectory()
    let installed = try extensionFiles(profile, id: firstID, name: "Off Store")
    let unpacked = profile.appendingPathComponent("Development")
    try write(["name": "Unpacked", "version": "1.0", "manifest_version": 3], to: unpacked.appendingPathComponent("manifest.json"))
    try write(["extensions": ["settings": [
      firstID: ["location": 1, "from_webstore": false, "path": installed.path],
      secondID: ["location": 4, "path": unpacked.path],
    ]]], to: profile.appendingPathComponent("Preferences"))
    let list = ChromiumExtensions.list(profile: profile)
    XCTAssertEqual(list.map(\.name), ["Off Store", "Unpacked"])
    XCTAssertEqual(list.map(\.path), [installed.path, unpacked.path])
    XCTAssertTrue(list.allSatisfy { $0.webStoreUrl == nil })
  }

  func testMergesPreferencesAndReadsEnabledAndPinnedState() throws {
    let profile = try temporaryDirectory()
    try write(["extensions": ["settings": [
      firstID: ["location": 1, "manifest": ["name": "First"], "state": 1],
      secondID: ["location": 1, "manifest": ["name": "Second"], "state": 1, "disable_reasons": [2]],
    ], "pinned_extensions": [firstID]]], to: profile.appendingPathComponent("Preferences"))
    try write(["extensions": ["settings": [firstID: ["state": 0]], "pinned_extensions": [secondID]]],
              to: profile.appendingPathComponent("Secure Preferences"))
    let list = ChromiumExtensions.list(profile: profile)
    XCTAssertEqual(list.map(\.enabled), [false, false])
    XCTAssertEqual(list.map(\.pinned), [true, true])
    XCTAssertEqual(list.map(\.name), ["First", "Second"])
  }

  func testVersionFallbackUsesStoredVersionThenLatestInstalledVersion() throws {
    let profile = try temporaryDirectory()
    let older = try extensionFiles(profile, id: firstID, version: "2.0_0", name: "Older")
    let newer = try extensionFiles(profile, id: firstID, version: "10.0_0", name: "Newer")
    try write(["extensions": ["settings": [firstID: ["location": 1, "manifest": ["version": "2.0"]]]]],
              to: profile.appendingPathComponent("Preferences"))
    XCTAssertEqual(ChromiumExtensions.list(profile: profile).first?.path.map { URL(fileURLWithPath: $0).lastPathComponent }, older.lastPathComponent)
    try write(["extensions": ["settings": [firstID: ["location": 1]]]], to: profile.appendingPathComponent("Preferences"))
    XCTAssertEqual(ChromiumExtensions.list(profile: profile).first?.path.map { URL(fileURLWithPath: $0).lastPathComponent }, newer.lastPathComponent)
  }

  func testRejectsOutsidePackagedPathsAndKeepsMissingFileMetadata() throws {
    let profile = try temporaryDirectory()
    let outside = profile.appendingPathComponent("Outside")
    try write(["name": "Unsafe", "version": "1.0", "manifest_version": 3], to: outside.appendingPathComponent("manifest.json"))
    for path in [outside.path, "../Outside", "\(secondID)/1.0_0"] {
      try write(["extensions": ["settings": [firstID: ["location": 1, "path": path, "manifest": ["name": "Metadata"]]]]],
                to: profile.appendingPathComponent("Preferences"))
      XCTAssertEqual(ChromiumExtensions.list(profile: profile).first?.name, "Metadata")
      XCTAssertNil(ChromiumExtensions.list(profile: profile).first?.path)
      XCTAssertThrowsError(try ChromiumExtensions.prepare(profile: profile, id: firstID, directory: profile.appendingPathComponent("Copies")))
    }
  }

  func testExcludesComponentsPoliciesThemesAndApps() throws {
    let profile = try temporaryDirectory()
    var settings: [String: Any] = [:]
    for (index, location) in [2, 3, 5, 6, 7, 8, 9, 10].enumerated() {
      settings[String(repeating: String(UnicodeScalar(97 + index)!), count: 32)] = ["location": location, "manifest": ["name": "Excluded"]]
    }
    settings[String(repeating: "i", count: 32)] = ["location": 1, "manifest": ["name": "Theme", "theme": [:]]]
    settings[String(repeating: "j", count: 32)] = ["location": 1, "manifest": ["name": "App", "app": [:]]]
    try write(["extensions": ["settings": settings]], to: profile.appendingPathComponent("Preferences"))
    XCTAssertEqual(ChromiumExtensions.list(profile: profile), [])
  }

  func testSnapshotIsIndependentRestoresKeyAndRemovesMetadata() throws {
    let profile = try temporaryDirectory()
    let source = try extensionFiles(profile, id: publicKeyID)
    try Data("original".utf8).write(to: source.appendingPathComponent("script.js"))
    try write(["checksum": "value"], to: source.appendingPathComponent("_metadata/verified_contents.json"))
    try write(["extensions": ["settings": [publicKeyID: ["location": 1, "from_webstore": true, "manifest": ["key": publicKey]]]]],
              to: profile.appendingPathComponent("Preferences"))
    let snapshots = profile.appendingPathComponent("Copies")
    let copied = try ChromiumExtensions.prepare(profile: profile, id: publicKeyID, directory: snapshots)
    let copiedAgain = try ChromiumExtensions.prepare(profile: profile, id: publicKeyID, directory: snapshots)
    XCTAssertNotEqual(copied, copiedAgain)
    XCTAssertTrue(FileManager.default.fileExists(atPath: source.appendingPathComponent("_metadata").path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: copied.appendingPathComponent("_metadata").path))
    let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: copied.appendingPathComponent("manifest.json"))) as! [String: Any]
    XCTAssertEqual(manifest["key"] as? String, publicKey)
    let originalManifest = try JSONSerialization.jsonObject(with: Data(contentsOf: source.appendingPathComponent("manifest.json"))) as! [String: Any]
    XCTAssertNil(originalManifest["key"])
    try FileManager.default.removeItem(at: source)
    XCTAssertEqual(try String(contentsOf: copied.appendingPathComponent("script.js"), encoding: .utf8), "original")
  }

  func testSnapshotRejectsSymlinksWithoutLeavingCopy() throws {
    let profile = try temporaryDirectory()
    let source = try extensionFiles(profile, id: firstID)
    let outside = profile.appendingPathComponent("secret")
    try Data("secret".utf8).write(to: outside)
    try FileManager.default.createSymbolicLink(at: source.appendingPathComponent("linked.js"), withDestinationURL: outside)
    try write(["extensions": ["settings": [firstID: ["location": 1]]]], to: profile.appendingPathComponent("Preferences"))
    let snapshots = profile.appendingPathComponent("Copies")
    XCTAssertThrowsError(try ChromiumExtensions.prepare(profile: profile, id: firstID, directory: snapshots))
    XCTAssertFalse(FileManager.default.fileExists(atPath: snapshots.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: outside.path))
  }

  func testSnapshotRequiresRealManifest() throws {
    let profile = try temporaryDirectory()
    let source = profile.appendingPathComponent("Extensions/\(firstID)/1.0_0")
    try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
    try write(["extensions": ["settings": [firstID: ["location": 1, "path": "\(firstID)/1.0_0", "manifest": ["name": "Metadata"]]]]],
              to: profile.appendingPathComponent("Preferences"))
    XCTAssertThrowsError(try ChromiumExtensions.prepare(profile: profile, id: firstID, directory: profile.appendingPathComponent("Copies")))
  }


  func testPackagedExtensionsRootCannotEscapeProfile() throws {
    let profile = try temporaryDirectory()
    let outside = try temporaryDirectory()
    let source = try extensionFiles(outside, id: firstID)
    try FileManager.default.createSymbolicLink(at: profile.appendingPathComponent("Extensions"),
                                               withDestinationURL: outside.appendingPathComponent("Extensions"))
    try write(["extensions": ["settings": [firstID: ["location": 1, "path": "\(firstID)/1.0_0", "manifest": ["name": "Metadata"]]]]],
              to: profile.appendingPathComponent("Preferences"))
    XCTAssertNil(ChromiumExtensions.list(profile: profile).first?.path)
    XCTAssertThrowsError(try ChromiumExtensions.prepare(profile: profile, id: firstID, directory: profile.appendingPathComponent("Copies")))
    XCTAssertTrue(FileManager.default.fileExists(atPath: source.appendingPathComponent("manifest.json").path))
  }

  func testSnapshotRejectsSymbolicLinkAncestorWithinProfile() throws {
    let profile = try temporaryDirectory()
    _ = try extensionFiles(profile, id: secondID)
    try FileManager.default.createSymbolicLink(at: profile.appendingPathComponent("Extensions/\(firstID)"),
                                               withDestinationURL: profile.appendingPathComponent("Extensions/\(secondID)"))
    try write(["extensions": ["settings": [firstID: ["location": 1, "path": "\(firstID)/1.0_0"]]]],
              to: profile.appendingPathComponent("Preferences"))
    XCTAssertNotNil(ChromiumExtensions.list(profile: profile).first?.path)
    XCTAssertThrowsError(try ChromiumExtensions.prepare(profile: profile, id: firstID, directory: profile.appendingPathComponent("Copies")))
  }


  func testDiscoveryAndImporterReadExtensionsFromEachChromiumProfile() throws {
    let support = try temporaryDirectory()
    let chromeDefault = support.appendingPathComponent("Google/Chrome/Default")
    let chromeWork = support.appendingPathComponent("Google/Chrome/Profile 1")
    let arcDefault = support.appendingPathComponent("Arc/User Data/Default")
    let cases = [
      ("chrome", "Default", chromeDefault, firstID, "Chrome Default", "Preferences"),
      ("chrome", "Profile 1", chromeWork, secondID, "Chrome Work", "Secure Preferences"),
      ("arc", "Default", arcDefault, firstID, "Arc Default", "Secure Preferences"),
    ]
    for (_, _, profile, id, name, file) in cases {
      _ = try extensionFiles(profile, id: id, name: name)
      try write(["extensions": ["settings": [id: ["location": 1, "from_webstore": true]]]],
                to: profile.appendingPathComponent(file))
    }
    let discovery = BrowserDiscovery(applicationSupport: support)
    let importer = Importer(discovery: discovery)
    for (browserId, profileId, profile, id, name, _) in cases {
      let browser = try XCTUnwrap(discovery.list().first { $0.id == browserId })
      let discovered = try XCTUnwrap(browser.profiles.first { $0.id == profileId })
      XCTAssertEqual(discovered.available, [.extensions])
      let imported = try importer.importData(browserId: browserId, profileId: profileId, kinds: [.extensions])
      XCTAssertEqual(imported.extensions.map(\.id), [id])
      XCTAssertEqual(imported.extensions.map(\.name), [name])
      XCTAssertEqual(imported.extensions, ChromiumExtensions.list(profile: profile))
      XCTAssertEqual(imported.failed, [])
      XCTAssertEqual(imported.warnings, [])
      XCTAssertEqual(try importer.importData(browserId: browserId, profileId: profileId, kinds: []).extensions, [])
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: chromeWork.appendingPathComponent("Preferences").path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: arcDefault.appendingPathComponent("Preferences").path))
  }


  func testStoreSnapshotAcceptsMatchingDiskPublicKey() throws {
    let profile = try temporaryDirectory()
    let source = try extensionFiles(profile, id: publicKeyID)
    try write(["name": "Example", "version": "1.0", "manifest_version": 3, "key": publicKey],
              to: source.appendingPathComponent("manifest.json"))
    try write(["extensions": ["settings": [publicKeyID: ["location": 1, "from_webstore": true]]]],
              to: profile.appendingPathComponent("Preferences"))
    let copied = try ChromiumExtensions.prepare(profile: profile, id: publicKeyID, directory: profile.appendingPathComponent("Copies"))
    let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: copied.appendingPathComponent("manifest.json"))) as! [String: Any]
    XCTAssertEqual(manifest["key"] as? String, publicKey)
  }

  func testSnapshotRejectsMissingStoreKeyAndInvalidOrMismatchedKeys() throws {
    let profile = try temporaryDirectory()
    let source = try extensionFiles(profile, id: firstID)
    let copies = profile.appendingPathComponent("Copies")
    for store in [true, false] {
      let keys: [Any?] = store ? [nil, "not-base64", publicKey, 1] : ["not-base64", publicKey, 1]
      for key in keys {
        var manifest: [String: Any] = ["name": "Example", "version": "1.0", "manifest_version": 3]
        manifest["key"] = key
        try write(manifest, to: source.appendingPathComponent("manifest.json"))
        try write(["extensions": ["settings": [firstID: ["location": 1, "from_webstore": store]]]],
                  to: profile.appendingPathComponent("Preferences"))
        XCTAssertThrowsError(try ChromiumExtensions.prepare(profile: profile, id: firstID, directory: copies)) { error in
          guard case ChromiumExtensions.PreparationError.invalidIdentity = error else {
            return XCTFail("Expected identity rejection, got \(error)")
          }
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: copies.path))
      }
    }
  }

  func testUnpackedSnapshotDoesNotRequirePublicKey() throws {
    let profile = try temporaryDirectory()
    let unpacked = profile.appendingPathComponent("Development")
    try write(["name": "Development", "version": "1.0", "manifest_version": 3], to: unpacked.appendingPathComponent("manifest.json"))
    try write(["extensions": ["settings": [firstID: ["location": 4, "path": unpacked.path]]]],
              to: profile.appendingPathComponent("Preferences"))
    let copied = try ChromiumExtensions.prepare(profile: profile, id: firstID, directory: profile.appendingPathComponent("Copies"))
    XCTAssertTrue(FileManager.default.fileExists(atPath: copied.appendingPathComponent("manifest.json").path))
  }


  func testOffStoreSnapshotDoesNotRequirePublicKey() throws {
    let profile = try temporaryDirectory()
    _ = try extensionFiles(profile, id: firstID)
    try write(["extensions": ["settings": [firstID: ["location": 1, "from_webstore": false]]]],
              to: profile.appendingPathComponent("Preferences"))
    let copied = try ChromiumExtensions.prepare(profile: profile, id: firstID, directory: profile.appendingPathComponent("Copies"))
    XCTAssertTrue(FileManager.default.fileExists(atPath: copied.appendingPathComponent("manifest.json").path))
  }

}
