import XCTest
@testable import BayImportCore

// Shapes Zen 1.22 writes (zen-sessions.jsonlz4, and the session store's window before 1.14), as a fake profile
// generated through Zen itself had them.
final class ZenSpacesTests: XCTestCase {
  private func tab(_ url: String, title: String = "", space: String? = nil, pinned: Bool = false, essential: Bool = false,
                   group: String? = nil, empty: Bool = false, context: Int = 0, loaded: Bool = true) -> [String: Any] {
    var t: [String: Any] = ["pinned": pinned, "zenEssential": essential, "zenIsEmpty": empty, "userContextId": context, "index": 1]
    t["entries"] = loaded ? [["url": url, "title": title]] : []
    if !loaded { t["userTypedValue"] = url; t["_zenPinnedInitialState"] = ["entry": [:], "image": NSNull()] }
    if let space { t["zenWorkspace"] = space }
    if let group { t["groupId"] = group }
    return t
  }

  private var document: [String: Any] {
    [
      "spaces": [
        ["uuid": "{home}", "name": "Home", "icon": "🏠", "containerTabId": 0,
         "theme": ["gradientColors": [["c": [58, 96, 115]]]]],
        ["uuid": "{dev}", "name": "Dev", "icon": "chrome://browser/skin/zen-icons/selectable/code.svg", "containerTabId": 0],
        ["uuid": "{meet}", "name": "Meetings", "icon": "📅", "containerTabId": 2],
      ],
      "folders": [
        ["id": "docs", "name": "Docs", "workspaceId": "{dev}", "parentId": NSNull()],
        ["id": "react", "name": "React", "workspaceId": "{dev}", "parentId": "docs"],
      ],
      "tabs": [
        tab("https://github.com/", title: "GitHub", pinned: true, essential: true),
        tab("https://app.slack.com/", pinned: true, essential: true, loaded: false),
        tab("https://work.example/", pinned: true, essential: true, context: 2),
        tab("https://news.ycombinator.com/", title: "HN", space: "{home}", pinned: true),
        tab("https://developer.mozilla.org/", title: "MDN", space: "{dev}", pinned: true),
        tab("about:blank", pinned: true, group: "docs", empty: true),
        tab("https://nodejs.org/", title: "Node", space: "{dev}", pinned: true, group: "docs"),
        tab("https://react.dev/", title: "React", space: "{dev}", pinned: true, group: "react"),
        tab("https://stackoverflow.com/", title: "SO", space: "{dev}", pinned: true),
        tab("https://linear.app/", space: "{dev}", pinned: true, loaded: false),
        tab("https://example.com/", title: "Example", space: "{home}"),
        tab("about:blank", space: "{home}", empty: true),
        tab("https://meet.google.com/", space: "{meet}", pinned: true),
      ],
    ]
  }

  private func spaces(_ doc: [String: Any]) throws -> [SpaceSuggestion] {
    try XCTUnwrap(ZenSpaces.parse(JSONSerialization.data(withJSONObject: doc), profileId: "Profiles/abc.Default"))
  }

  func testEachSpaceKeepsItsPinsFoldersAndTabs() throws {
    let result = try spaces(document)
    XCTAssertEqual(result.map(\.name), ["Home", "Dev", "Meetings"])
    XCTAssertEqual(result.map(\.profileId), Array(repeating: "Profiles/abc.Default", count: 3))
    let home = result[0], dev = result[1]
    XCTAssertEqual(home.pinned.map(\.url), ["https://news.ycombinator.com/"])
    XCTAssertEqual(home.tabs.map(\.url), ["https://example.com/"], "the empty-space placeholder isn't a tab")
    // A folder takes its first tab's place; a nested one sits inside it; the folder's placeholder is gone.
    XCTAssertEqual(dev.pinned.map { $0.type == .folder ? "folder:\($0.title)" : $0.url! },
                   ["https://developer.mozilla.org/", "folder:Docs", "https://stackoverflow.com/", "https://linear.app/"])
    let docs = dev.pinned[1]
    XCTAssertEqual(docs.children?.map { $0.type == .folder ? "folder:\($0.title)" : $0.url! }, ["https://nodejs.org/", "folder:React"])
    XCTAssertEqual(docs.children?[1].children?.map(\.url), ["https://react.dev/"])
  }

  func testEssentialsGoToTheSpacesOfTheirContainer() throws {
    let result = try spaces(document)
    XCTAssertEqual(result[0].favorites?.map(\.url), ["https://github.com/", "https://app.slack.com/"])
    XCTAssertEqual(result[1].favorites?.map(\.url), ["https://github.com/", "https://app.slack.com/"])
    XCTAssertEqual(result[2].favorites?.map(\.url), ["https://work.example/"])
    XCTAssertTrue(result[0].favorites?.allSatisfy(\.pinned) ?? false)
  }

  func testUnloadedPinsKeepWhereTheyPoint() throws {
    let result = try spaces(document)
    XCTAssertTrue(result[1].pinned.contains { $0.url == "https://linear.app/" })
    XCTAssertTrue(result[0].favorites?.contains { $0.url == "https://app.slack.com/" } ?? false)
  }

  func testIconsAndColors() throws {
    let result = try spaces(document)
    XCTAssertEqual(result[0].emoji, "🏠")
    XCTAssertEqual(result[0].color, "#3A6073")
    XCTAssertNil(result[1].emoji, "a Zen symbol isn't an emoji")
    XCTAssertEqual(result[2].emoji, "📅")
  }

  func testTheSessionStoresWindowReadsTheSame() throws {
    let fromWindow = try spaces(["windows": [document]])
    XCTAssertEqual(fromWindow.map(\.name), try spaces(document).map(\.name))
    XCTAssertEqual(fromWindow[1].pinned.count, 4)
  }

  func testFirefoxWithoutSpacesHasNone() throws {
    let firefox = try JSONSerialization.data(withJSONObject: ["windows": [["tabs": [tab("https://example.com/")]]]])
    XCTAssertNil(try ZenSpaces.parse(firefox, profileId: "p"))
  }

  func testFirefoxSessionKeepsUnloadedTabsAndDropsZensPlaceholders() throws {
    let session = try JSONSerialization.data(withJSONObject: ["windows": [["tabs": [
      tab("https://linear.app/", pinned: true, loaded: false),
      tab("about:blank", pinned: true, empty: true),
      tab("https://example.com/", title: "Example"),
    ]]]])
    XCTAssertEqual(try Firefox.session(session).tabs.map(\.url), ["https://linear.app/", "https://example.com/"])
  }
}

// A primary password set by NSS today (Zen 1.22) keeps a 48-byte global salt hashed with SHA-384; the profile in
// fixtures/zen-primary was made by Zen with the primary password "work-primary" (fake logins only).
final class ZenPrimaryPasswordTests: XCTestCase {
  private let profile = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("fixtures/zen-primary", isDirectory: true)

  func testTheRightPrimaryPasswordOpensTheLogins() throws {
    let logins = try FirefoxLogins.logins(profile: profile, primaryPassword: "work-primary")
    XCTAssertEqual(logins.map(\.username).sorted(), ["work@corp.example", "work@corp.example"])
    XCTAssertEqual(Set(logins.map(\.password)), ["linear-fake-4", "figma-fake-5"])
  }

  func testAWrongOneIsLocked() {
    XCTAssertThrowsError(try FirefoxLogins.logins(profile: profile, primaryPassword: "nope")) { error in
      guard case ImportError.locked = error else { return XCTFail("\(error)") }
    }
    XCTAssertThrowsError(try FirefoxLogins.logins(profile: profile, primaryPassword: ""))
  }
}
