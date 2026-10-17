import CryptoKit
import Foundation
import XCTest
@testable import BayImportCore

final class FirefoxExtensionsTests: XCTestCase {
  private let addonID = "example@tests.invalid"

  private func temporaryDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    return directory
  }

  private func writeJSON(_ value: [String: Any], _ url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONSerialization.data(withJSONObject: value).write(to: url)
  }

  private func manifest(_ values: [String: Any] = [:]) -> [String: Any] {
    var result: [String: Any] = ["name": "Example", "version": "1.0", "manifest_version": 3,
                                "browser_specific_settings": ["gecko": ["id": addonID]]]
    result.merge(values) { _, new in new }
    return result
  }

  private func profile(manifest: [String: Any], scripts: [String: String] = [:], active: Bool = true) throws -> URL {
    let profile = try temporaryDirectory()
    var files = scripts.map { ($0.key, Data($0.value.utf8), UInt32(0x81a4)) }
    files.append(("manifest.json", try JSONSerialization.data(withJSONObject: manifest), UInt32(0x81a4)))
    try FileManager.default.createDirectory(at: profile.appendingPathComponent("extensions"), withIntermediateDirectories: true)
    try archive(files).write(to: profile.appendingPathComponent("extensions/installed.xpi"))
    try writeJSON(["addons": [["id": addonID, "defaultLocale": ["name": "Example"], "type": "extension",
                               "location": "app-profile", "active": active, "userDisabled": !active,
                               "path": "extensions/installed.xpi", "signedState": 2]]], profile.appendingPathComponent("extensions.json"))
    return profile
  }

  private func prepared(_ profile: URL) throws -> URL {
    try FirefoxExtensions.prepare(profile: profile, id: addonID, directory: profile.appendingPathComponent("Copies"))
  }

  private func readManifest(_ directory: URL) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("manifest.json"))) as! [String: Any]
  }

  func testFixtureInventoryIncludesDisabledUserAddonsAndExcludesSystemAndThemes() throws {
    let inventory = FirefoxExtensions.list(profile: Fixtures.url("firefox-extensions/profile"))
    XCTAssertEqual(inventory.map(\.id), ["example@tests.invalid", "disabled@tests.invalid"])
    XCTAssertEqual(inventory.map(\.enabled), [true, false])
    XCTAssertTrue(inventory.allSatisfy { $0.source == "firefox" && $0.updateMode == "local" && !$0.warnings.isEmpty })
    XCTAssertTrue(inventory.allSatisfy { $0.compatibility?.status == "compatible" })
  }

  func testMV3ScriptsBecomeInstallableWorkerAndShimPreservesHostPermissions() throws {
    let profile = try profile(manifest: manifest([
      "permissions": ["storage", "menus", "https://example.com/*"],
      "optional_permissions": ["https://optional.invalid/*"],
      "background": ["scripts": ["background.js"]],
      "content_scripts": [["matches": ["https://example.com/*"], "js": ["content.js"]]],
      "content_security_policy": ["extension_pages": "script-src 'self'; object-src 'self'"],
    ]), scripts: ["background.js": "browser.runtime.getBrowserInfo().then(console.log);", "content.js": "browser.storage.local.get('x');"])
    let destination = try prepared(profile)
    let converted = try readManifest(destination)
    XCTAssertEqual(converted["manifest_version"] as? Int, 3)
    XCTAssertEqual(converted["permissions"] as? [String], ["storage", "contextMenus"])
    XCTAssertEqual(converted["host_permissions"] as? [String], ["https://example.com/*"])
    XCTAssertEqual(converted["optional_host_permissions"] as? [String], ["https://optional.invalid/*"])
    XCTAssertEqual((converted["background"] as? [String: Any])?["service_worker"] as? String, "bay-firefox-background.js")
    XCTAssertNil(converted["browser_specific_settings"])
    let worker = try String(contentsOf: destination.appendingPathComponent("bay-firefox-background.js"), encoding: .utf8)
    XCTAssertEqual(worker, "importScripts(\"bay-firefox-compat.js\",\"background.js\");\n")
    let content = converted["content_scripts"] as! [[String: Any]]
    XCTAssertEqual(content[0]["js"] as? [String], ["bay-firefox-compat.js", "content.js"])
    XCTAssertTrue(try String(contentsOf: destination.appendingPathComponent("bay-firefox-compat.js"), encoding: .utf8).contains("Promise.resolve"))
  }

  func testContentOnlyMV2ConvertsActionResourcesAndCSP() throws {
    let profile = try profile(manifest: manifest([
      "manifest_version": 2,
      "browser_action": ["default_popup": "ui/popup.html", "browser_style": true],
      "web_accessible_resources": ["images/*"],
      "permissions": ["<all_urls>", "storage"],
      "content_security_policy": "script-src 'self'; object-src 'self'",
    ]), scripts: ["ui/popup.html": "<!doctype html><html><head></head><body>Popup</body></html>", "template.html": "<div>Template fragment</div>"])
    let destination = try prepared(profile)
    let converted = try readManifest(destination)
    XCTAssertEqual(converted["manifest_version"] as? Int, 3)
    XCTAssertNil(converted["browser_action"])
    XCTAssertEqual((converted["action"] as? [String: Any])?["default_popup"] as? String, "ui/popup.html")
    XCTAssertNil((converted["action"] as? [String: Any])?["browser_style"])
    let resources = converted["web_accessible_resources"] as! [[String: Any]]
    XCTAssertEqual(resources[0]["resources"] as? [String], ["images/*"])
    XCTAssertEqual(resources[0]["matches"] as? [String], ["<all_urls>"])
    XCTAssertEqual((converted["content_security_policy"] as? [String: Any])?["extension_pages"] as? String, "script-src 'self'; object-src 'self'")
    XCTAssertTrue(try String(contentsOf: destination.appendingPathComponent("ui/popup.html"), encoding: .utf8).contains("<head><script src=\"../bay-firefox-compat.js\"></script>"))
    XCTAssertEqual(try String(contentsOf: destination.appendingPathComponent("template.html"), encoding: .utf8), "<div>Template fragment</div>")
  }

  func testNonPersistentMV2BackgroundCanBeConvertedButPersistentAndDOMCannot() throws {
    let supported = try profile(manifest: manifest(["manifest_version": 2, "background": ["scripts": ["background.js"], "persistent": false]]),
                                scripts: ["background.js": "browser.runtime.onMessage.addListener(() => Promise.resolve('ok'));"])
    XCTAssertNoThrow(try prepared(supported))
    for background in [["scripts": ["background.js"]], ["scripts": ["background.js"], "persistent": true], ["page": "background.html"]] as [[String: Any]] {
      let source = try profile(manifest: manifest(["manifest_version": 2, "background": background]), scripts: ["background.js": "document.title = 'x';"])
      XCTAssertEqual(FirefoxExtensions.list(profile: source).first?.compatibility?.status, "unsupported")
      XCTAssertThrowsError(try prepared(source))
      XCTAssertFalse(FileManager.default.fileExists(atPath: source.appendingPathComponent("Copies").path))
    }
  }

  func testBrowserActionAliasAndPageActionRejection() throws {
    let source = try profile(manifest: manifest(["manifest_version": 2, "browser_action": ["default_title": "Example"]]),
                             scripts: ["content.js": "browser.browserAction.setBadgeText({text:'1'});"])
    let destination = try prepared(source)
    XCTAssertTrue(try String(contentsOf: destination.appendingPathComponent("bay-firefox-compat.js"), encoding: .utf8).contains("api.browserAction = api.action"))
    let pageAction = try profile(manifest: manifest(["manifest_version": 2, "page_action": ["default_title": "Example"]]))
    XCTAssertThrowsError(try prepared(pageAction))
    let pageActionAPI = try profile(manifest: manifest(), scripts: ["content.js": "browser.pageAction.show(1);"])
    XCTAssertThrowsError(try prepared(pageActionAPI))
  }

  func testLegacyGetURLUsesRealRuntimeEquivalentAndRemovedLegacyAPIsAreRejected() throws {
    let source = try profile(manifest: manifest(["manifest_version": 2]), scripts: ["content.js": "browser.extension.getURL('images/icon.png');"])
    let destination = try prepared(source)
    let shim = try String(contentsOf: destination.appendingPathComponent("bay-firefox-compat.js"), encoding: .utf8)
    XCTAssertTrue(shim.contains("api.extension.getURL = api.runtime.getURL.bind(api.runtime)"))
    for api in ["extension.lastError", "extension.onRequest", "extension.onRequestExternal", "extension.sendRequest",
                "extension.getExtensionTabs", "tabs.getAllInWindow", "tabs.getSelected", "tabs.sendRequest",
                "tabs.onActiveChanged", "tabs.onHighlightChanged", "tabs.onSelectionChanged"] {
      let legacy = try profile(manifest: manifest(["manifest_version": 2]), scripts: ["content.js": "browser.\(api);"])
      XCTAssertThrowsError(try prepared(legacy), api)
      XCTAssertTrue(FirefoxExtensions.list(profile: legacy).first?.compatibility?.reasons.contains(where: { $0.contains(api) }) == true, api)
    }
  }

  func testTransitiveBackgroundDependenciesRejectDOMAndDynamicImports() throws {
    let background = manifest(["background": ["scripts": ["background.js"]]])
    let dom = try profile(manifest: background, scripts: ["background.js": "importScripts('helper.js');", "helper.js": "document.title = 'x';"])
    XCTAssertThrowsError(try prepared(dom))
    XCTAssertTrue(FirefoxExtensions.list(profile: dom).first?.compatibility?.reasons.contains(where: { $0.contains("helper.js") && $0.contains("DOM") }) == true)
    let dynamic = try profile(manifest: background, scripts: ["background.js": "importScripts(getPath());"])
    XCTAssertThrowsError(try prepared(dynamic))
    let equivalent = try profile(manifest: background, scripts: ["background.js": "importScripts('helper.js');", "helper.js": "browser.storage.local.get('x');"])
    XCTAssertNoThrow(try prepared(equivalent))
  }

  func testUnsupportedPrivilegesAndAPIsAreReportedAndNeverDropped() throws {
    let source = try profile(manifest: manifest(["permissions": ["contextualIdentities", "webRequestBlocking", "proxy"],
                                               "sidebar_action": ["default_panel": "sidebar.html"]]),
                             scripts: ["content.js": "browser.webRequest.filterResponseData('1'); browser.contextualIdentities.query({});"])
    let row = try XCTUnwrap(FirefoxExtensions.list(profile: source).first)
    XCTAssertEqual(row.compatibility?.status, "unsupported")
    for fragment in ["contextualIdentities", "webRequestBlocking", "proxy", "sidebar_action", "filterResponseData"] {
      XCTAssertTrue(row.compatibility?.reasons.contains(where: { $0.contains(fragment) }) == true, fragment)
    }
    XCTAssertThrowsError(try prepared(source))
  }

  func testIdentityIsStableAcrossRetriesAndIndependentProfilesAndSourceIsUnchanged() throws {
    let source = try profile(manifest: manifest())
    let another = try profile(manifest: manifest())
    let before = try Data(contentsOf: source.appendingPathComponent("extensions/installed.xpi"))
    let first = try readManifest(prepared(source))
    let second = try readManifest(prepared(source))
    let third = try readManifest(prepared(another))
    XCTAssertEqual(first["key"] as? String, second["key"] as? String)
    XCTAssertEqual(first["key"] as? String, third["key"] as? String)
    let key = try XCTUnwrap(Data(base64Encoded: first["key"] as! String))
    XCTAssertEqual(key.count, 44) // Valid Ed25519 SPKI prefix and 32-byte public key.
    XCTAssertEqual(Array(key.prefix(12)), [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0])
    XCTAssertEqual(FirefoxExtensions.list(profile: source).first?.destinationId, FirefoxExtensions.destinationId(addonID))
    XCTAssertNotEqual(FirefoxExtensions.destinationId(addonID), FirefoxExtensions.destinationId("other@tests.invalid"))
    XCTAssertEqual(try Data(contentsOf: source.appendingPathComponent("extensions/installed.xpi")), before)
  }

  func testRejectsMaliciousArchivePathsSymlinksAndFileDirectoryCollisions() throws {
    for (name, mode) in [("../escaped.js", UInt32(0x81a4)), ("/escaped.js", 0x81a4), ("a\\escaped.js", 0x81a4),
                         ("linked.js", 0xa1ff), ("pipe.js", 0x11ff), ("a//script.js", 0x81a4), ("a:stream", 0x81a4)] {
      let source = try profile(manifest: manifest())
      let files = [("manifest.json", try JSONSerialization.data(withJSONObject: manifest()), UInt32(0x81a4)),
                   (name, Data("target".utf8), mode)]
      try archive(files).write(to: source.appendingPathComponent("extensions/installed.xpi"))
      XCTAssertEqual(FirefoxExtensions.list(profile: source).first?.compatibility?.status, "unsupported", name)
      XCTAssertThrowsError(try prepared(source), name)
      XCTAssertFalse(FileManager.default.fileExists(atPath: source.appendingPathComponent("Copies").path))
    }
    let source = try profile(manifest: manifest())
    try archive([("manifest.json", try JSONSerialization.data(withJSONObject: manifest()), 0x81a4),
                 ("a", Data(), 0x81a4), ("a/file.js", Data(), 0x81a4)]).write(to: source.appendingPathComponent("extensions/installed.xpi"))
    XCTAssertThrowsError(try prepared(source))
  }

  func testRejectsCaseAndUnicodeAliasedArchiveNames() throws {
    for names in [["content.js", "CONTENT.js"], ["é.js", "e\u{301}.js"]] {
      let source = try profile(manifest: manifest())
      try archive([("manifest.json", try JSONSerialization.data(withJSONObject: manifest()), 0x81a4),
                   (names[0], Data(), 0x81a4), (names[1], Data(), 0x81a4)]).write(to: source.appendingPathComponent("extensions/installed.xpi"))
      XCTAssertThrowsError(try prepared(source))
      XCTAssertFalse(FileManager.default.fileExists(atPath: source.appendingPathComponent("Copies").path))
    }
  }

  func testRejectsPackageSymlinkAndOutsideProfile() throws {
    let source = try profile(manifest: manifest())
    let other = try profile(manifest: manifest())
    let package = source.appendingPathComponent("extensions/installed.xpi")
    try FileManager.default.removeItem(at: package)
    try FileManager.default.createSymbolicLink(at: package, withDestinationURL: other.appendingPathComponent("extensions/installed.xpi"))
    XCTAssertNil(FirefoxExtensions.list(profile: source).first?.path)
    XCTAssertThrowsError(try prepared(source))
    try writeJSON(["addons": [["id": addonID, "type": "extension", "location": "app-profile", "path": other.appendingPathComponent("extensions/installed.xpi").path]]], source.appendingPathComponent("extensions.json"))
    XCTAssertNil(FirefoxExtensions.list(profile: source).first?.path)
  }

  func testRejectsIdentityMismatchDynamicAPIsAndForbiddenCSP() throws {
    let cases: [([String: Any], [String: String])] = [
      (["browser_specific_settings": ["gecko": ["id": "different@tests.invalid"]]], [:]),
      (["content_security_policy": "script-src 'self' 'unsafe-eval'; object-src 'self'"], [:]),
      ([:], ["content.js": "browser['proxy'].settings.get({});"]),
      (["background": ["scripts": ["worker.js"], "type": "module"]], ["worker.js": "export const a=1;"]),
    ]
    for (changes, scripts) in cases {
      let source = try profile(manifest: manifest(changes), scripts: scripts)
      XCTAssertThrowsError(try prepared(source))
      XCTAssertEqual(FirefoxExtensions.list(profile: source).first?.compatibility?.status, "unsupported")
    }
  }

  // Store-only archives keep malicious central attributes visible without depending on shell zip.
  private func archive(_ files: [(String, Data, UInt32)]) -> Data {
    var output = Data()
    var directory = Data()
    for (name, body, mode) in files {
      let encoded = Data(name.utf8)
      let offset = output.count
      output.le32(0x04034b50); output.le16(20); output.le16(0x800); output.le16(0)
      output.le16(0); output.le16(0); output.le32(0); output.le32(UInt32(body.count)); output.le32(UInt32(body.count))
      output.le16(UInt16(encoded.count)); output.le16(0); output.append(encoded); output.append(body)
      directory.le32(0x02014b50); directory.le16(0x314); directory.le16(20); directory.le16(0x800); directory.le16(0)
      directory.le16(0); directory.le16(0); directory.le32(0); directory.le32(UInt32(body.count)); directory.le32(UInt32(body.count))
      directory.le16(UInt16(encoded.count)); directory.le16(0); directory.le16(0); directory.le16(0); directory.le16(0)
      directory.le32(mode << 16); directory.le32(UInt32(offset)); directory.append(encoded)
    }
    let offset = output.count
    output.append(directory)
    output.le32(0x06054b50); output.le16(0); output.le16(0); output.le16(UInt16(files.count)); output.le16(UInt16(files.count))
    output.le32(UInt32(directory.count)); output.le32(UInt32(offset)); output.le16(0)
    return output
  }
}

private extension Data {
  mutating func le16(_ value: UInt16) { append(UInt8(value & 255)); append(UInt8(value >> 8)) }
  mutating func le32(_ value: UInt32) { le16(UInt16(value & 65535)); le16(UInt16(value >> 16)) }
}
