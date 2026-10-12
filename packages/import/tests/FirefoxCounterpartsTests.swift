import XCTest
@testable import BayImportCore

final class FirefoxCounterpartsTests: XCTestCase {
  func testPublisherVerifiedCounterpartRetainsSourceIdentityAndDisabledState() {
    let original = ImportedExtension(id: "addon@darkreader.org", name: "Dark Reader", webStoreUrl: nil,
                                    enabled: false, source: "firefox",
                                    compatibility: ImportedExtensionCompatibility(status: "unsupported", reasons: ["Requires request blocking"]))
    let mapped = FirefoxExtensionCounterparts.resolve(original)
    XCTAssertEqual(mapped.id, original.id)
    XCTAssertFalse(mapped.enabled)
    XCTAssertEqual(mapped.destinationId, "eimadpbcbfnmbkopoojfekhnkhdbieeh")
    XCTAssertEqual(mapped.webStoreUrl, "https://chromewebstore.google.com/detail/eimadpbcbfnmbkopoojfekhnkhdbieeh")
    XCTAssertEqual(mapped.updateMode, "store")
    XCTAssertEqual(mapped.compatibility?.status, "compatible")
    XCTAssertEqual(mapped.compatibility?.reasons, [])
    XCTAssertTrue(mapped.warnings.contains { $0.contains("Firefox extension settings aren't migrated") })
  }

  func testMatchingDisplayNameNeverChoosesAnotherPublishersExtension() {
    let original = ImportedExtension(id: "unknown@example.org", name: "Dark Reader", webStoreUrl: nil, source: "firefox")
    XCTAssertEqual(FirefoxExtensionCounterparts.resolve(original), original)
  }

  func testCounterpartsHaveValidChromiumIdsAndOfficialFirefoxAliases() {
    XCTAssertEqual(FirefoxExtensionCounterparts.identifiers.count, 4)
    XCTAssertTrue(FirefoxExtensionCounterparts.identifiers.values.allSatisfy(ChromiumExtensions.isExtensionId))
    XCTAssertEqual(FirefoxExtensionCounterparts.identifiers["jid1-MnnxcxisBPnSXQ@jetpack"],
                   FirefoxExtensionCounterparts.identifiers["jid1-MnnxcxisBPnSXQ-eff@jetpack"])
  }

  func testFirefoxAndZenDiscoverAndImportProfileScopedExtensions() throws {
    let support = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: support) }
    for (browserId, folder) in [("firefox", "Firefox"), ("zen", "zen")] {
      let root = support.appendingPathComponent(folder)
      let profile = root.appendingPathComponent("Profiles/default")
      try FileManager.default.createDirectory(at: profile.deletingLastPathComponent(), withIntermediateDirectories: true)
      try FileManager.default.copyItem(at: Fixtures.url("firefox-extensions/profile"), to: profile)
      try "[Profile0]\nName=Default\nIsRelative=1\nPath=Profiles/default\nDefault=1\n".write(to: root.appendingPathComponent("profiles.ini"), atomically: true, encoding: .utf8)
      let discovery = BrowserDiscovery(applicationSupport: support)
      let source = try XCTUnwrap(discovery.source(BrowserDefinition.find(browserId)!))
      XCTAssertEqual(source.family, .firefox)
      XCTAssertFalse(source.needsKeychain)
      XCTAssertEqual(source.profiles.first?.available, [.extensions])
      let result = try Importer(discovery: discovery).importData(browserId: browserId, profileId: "Profiles/default", kinds: [.extensions])
      XCTAssertEqual(result.extensions.map(\.id), ["example@tests.invalid", "disabled@tests.invalid"])
      XCTAssertEqual(result.extensions.map(\.enabled), [true, false])
      XCTAssertEqual(result.failed, [])
      XCTAssertTrue(try Importer(discovery: discovery).importData(browserId: browserId, profileId: "Profiles/default", kinds: []).extensions.isEmpty)
    }
  }
}
