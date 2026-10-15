import Foundation
import XCTest
@testable import BayImportCore

final class ArcSidebarTests: XCTestCase {
  func testNestedFoldersEmptyFoldersSplitViewsAndCustomTitlesSurviveTheWire() throws {
    let sidebar = try ArcSidebar.parse(Data(contentsOf: Fixtures.url("arc/nested-sidebar.json")))
    let space = try XCTUnwrap(sidebar.spaces.first)
    var renamed = BookmarkNode.link("My work", "https://work-tab.example/")
    renamed.pageTitle = "Work page"
    XCTAssertEqual(space.pinned, [
      .link("Loose page", "https://loose.example/"),
      .folder("Work", [
        renamed,
        .folder("Research", [
          .link("Research page", "https://inner-tab.example/"),
          .folder("Empty child", []),
          .link("Left page", "https://left.example/"),
          .link("Right page", "https://right.example/"),
        ]),
        .link("Last work page", "https://tail.example/"),
      ]),
      .folder("Empty root", []),
    ])
    XCTAssertEqual(space.pinned.reduce(0) { $0 + $1.linkCount }, 6, "Cycles, duplicate references and missing items add no rows")
    let encoded = try JSONEncoder().encode(space)
    XCTAssertEqual(try JSONDecoder().decode(SpaceSuggestion.self, from: encoded), space)
  }

  func testOverflowFoldersKeepAllTabsAtTheFifthLevelWithoutATraversalCutoff() throws {
    var items: [[String: Any]] = [["id": "root", "childrenIds": ["folder-1"]]]
    for depth in 1...80 {
      items.append([
        "id": "folder-\(depth)", "title": "Level \(depth)", "data": ["list": [:]],
        "childrenIds": ["tab-\(depth)"] + (depth < 80 ? ["folder-\(depth + 1)"] : ["root"]),
      ])
      items.append([
        "id": "tab-\(depth)", "childrenIds": [],
        "data": ["tab": ["savedURL": "https://level-\(depth).example/", "savedTitle": "Tab \(depth)"]],
      ])
    }
    let data = try JSONSerialization.data(withJSONObject: ["sidebar": ["containers": [[
      "spaces": [["id": "deep", "containerIDs": ["pinned", "root"]]], "items": items,
    ]]]])
    let pinned = try XCTUnwrap(ArcSidebar.parse(data).spaces.first).pinned
    XCTAssertEqual(pinned.reduce(0) { $0 + $1.linkCount }, 80)
    var nodes = pinned
    for depth in 1...5 {
      let folder = try XCTUnwrap(nodes.last)
      XCTAssertEqual(folder.type, .folder)
      XCTAssertEqual(folder.title, "Level \(depth)")
      nodes = folder.children ?? []
    }
    XCTAssertTrue(nodes.allSatisfy { $0.type == .url })
    XCTAssertEqual(nodes.map(\.title), (5...80).map { "Tab \($0)" })
  }
}
