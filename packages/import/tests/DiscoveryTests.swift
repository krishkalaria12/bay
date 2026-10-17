import Foundation
import XCTest
@testable import BayImportCore

final class DiscoveryTests: XCTestCase {
  func testInstalledAppsDoNotRequireBrowsingDataOrStandardApplicationPaths() throws {
    let support = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let firefox = URL(fileURLWithPath: "/Users/example/Applications/Firefox.app")
    let helium = URL(fileURLWithPath: "/Volumes/Apps/Helium.app")
    let installed = ["org.mozilla.firefox": firefox, "net.imput.helium": helium]
    let discovery = BrowserDiscovery(
      applicationSupport: support,
      locateApp: { ids in ids.compactMap { installed[$0] }.first },
      iconFor: { _, id in "/tmp/icons/\(id).png" }
    )

    XCTAssertTrue(discovery.list().isEmpty)
    let apps = discovery.installedApplications()
    XCTAssertEqual(apps.map(\.id), ["firefox", "helium"])
    XCTAssertEqual(apps.map(\.name), ["Firefox", "Helium"])
    XCTAssertEqual(apps.map(\.appPath), [firefox.path, helium.path])
    XCTAssertEqual(apps.map(\.iconPath), ["/tmp/icons/firefox.png", "/tmp/icons/helium.png"])
  }

  func testMissingIconDoesNotDropInstalledBrowser() throws {
    let discovery = BrowserDiscovery(
      applicationSupport: FileManager.default.temporaryDirectory,
      locateApp: { ids in
        ids.contains("net.imput.helium") ? URL(fileURLWithPath: "/Applications/Helium.app") : nil
      }
    )

    let app = try XCTUnwrap(discovery.installedApplications().first)
    XCTAssertEqual(app.name, "Helium")
    XCTAssertNil(app.iconPath)
    XCTAssertEqual(discovery.installedApplications().count, 1)
  }
}
