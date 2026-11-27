import Foundation
import XCTest
@testable import BayImportCore

/// The Swift readers answer as the shared readers did for every fixture profile (fixtures/wire, recorded by
/// scripts/record-wire.py from the code Windows and Linux run), so macOS and the other desktops import the same things.
final class WireParityTests: XCTestCase {
  struct Tabs: Decodable, Equatable {
    var tabs: [ImportedTab]
    var groups: [ImportedTabGroup]
  }

  struct Sidebar: Decodable, Equatable {
    var spaces: [SpaceSuggestion]
    var favorites: [String: [ImportedTab]]
  }

  static let chromium: [(String, String)] = [
    ("chrome-default", "Google/Chrome/Default"),
    ("chrome-profile-1", "Google/Chrome/Profile 1"),
    ("brave-default", "BraveSoftware/Brave-Browser/Default"),
    ("dia-default", "Dia/User Data/Default"),
    ("dia-profile-2", "Dia/User Data/Profile 2"),
    ("arc-default", "Arc/User Data/Default"),
    ("opera", "com.operasoftware.Opera"),
    ("helium-default", "net.imput.helium/Default"),
  ]

  var differences: [String] = []

  func golden<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(contentsOf: Fixtures.url("wire/\(name).json")))
  }

  func compare<T: Decodable & Equatable>(_ name: String, _ value: T) throws {
    if try golden(name, as: T.self) != value { differences.append(name) }
  }

  func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }

  func testTheSwiftReadersAnswerAsTheSharedReaders() throws {
    for name in ["chrome-passwords", "bitwarden", "firefox-passwords"] {
      try compare("csv-\(name)", try PasswordsCSV.load(Fixtures.url("csv/\(name).csv")))
    }
    try compare("html-chrome-bookmarks", try NetscapeBookmarks.load(Fixtures.url("html/chrome-bookmarks.html")))
    for (name, path) in Self.chromium {
      let profile = Fixtures.support(path)
      if exists(profile.appendingPathComponent("Bookmarks")) {
        try compare("bookmarks-\(name)", try ChromiumBookmarks.load(profile: profile))
      }
      if exists(profile.appendingPathComponent("History")) {
        try compare("history-\(name)", try HistoryReader.read(profile.appendingPathComponent("History"), flavor: .chromium).entries)
      }
      if exists(profile.appendingPathComponent("Sessions")) {
        let tabs = try ChromiumSessions.load(profile: profile, key: nil)
        try compare("tabs-\(name)", Tabs(tabs: tabs.tabs, groups: tabs.groups))
      }
    }
    let firefox = Fixtures.support("Firefox/Profiles/abcd1234.default-release")
    try compare("bookmarks-firefox-default", try Firefox.bookmarks(places: firefox.appendingPathComponent("places.sqlite")))
    try compare("history-firefox-default", try HistoryReader.read(firefox.appendingPathComponent("places.sqlite"), flavor: .firefox).entries)
    let session = try Firefox.loadSession(profile: firefox)
    try compare("tabs-firefox-default", Tabs(tabs: session.tabs, groups: session.groups))
    for (name, path) in [("arc-sidebar", Fixtures.support("Arc/StorableSidebar.json")), ("arc-nested-sidebar", Fixtures.url("arc/nested-sidebar.json"))] {
      let sidebar = try ArcSidebar.parse(Data(contentsOf: path))
      try compare(name, Sidebar(spaces: sidebar.spaces, favorites: sidebar.favorites))
    }
    XCTAssertEqual(differences, [], "readers whose Swift answers differ from the shared readers'")
  }
}
