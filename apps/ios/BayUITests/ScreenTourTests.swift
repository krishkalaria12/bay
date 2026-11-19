import XCTest

/// Walks Bay's main screens and saves a screenshot of each, for checking a language, a text size or an appearance by
/// eye: the start page, the search card, the page menu, the tab switcher, Settings and its General page, and the
/// welcome's first page. Runs only when `BAY_SHOTS` names a folder to save into (`TEST_RUNNER_BAY_SHOTS=… xcodebuild
/// test -only-testing:BayUITests/ScreenTourTests`); `BAY_ARGS` passes launch arguments, such as `-bay.locale de` for
/// Bay's language or `-UIPreferredContentSizeCategoryName UICTContentSizeCategoryAccessibilityXXXL` for the text size.
@MainActor
final class ScreenTourTests: XCTestCase {
  private let app = XCUIApplication()

  func testTour() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let folder = environment["BAY_SHOTS"], !folder.isEmpty else { throw XCTSkip("BAY_SHOTS isn't set") }
    let prefix = environment["BAY_PREFIX"].map { "\($0)-" } ?? ""
    try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    func shot(_ name: String) {
      sleep(1)
      let url = URL(fileURLWithPath: folder).appendingPathComponent("\(prefix)\(name).png")
      try? XCUIScreen.main.screenshot().pngRepresentation.write(to: url)
    }

    app.launchArguments = (environment["BAY_ARGS"] ?? "").split(separator: " ").map(String.init)
    app.launch()
    let skip = app.buttons["welcome-skip"]
    if skip.waitForExistence(timeout: 3) { skip.tap() }
    let dismiss = app.buttons["search-dismiss"]
    if dismiss.waitForExistence(timeout: 3) { dismiss.tap() }
    app.open(URL(string: "bay://new-tab")!)
    XCTAssertTrue(app.buttons["start-screen"].waitForExistence(timeout: 10))
    shot("start")

    app.buttons["start-screen"].tap()
    let field = app.textFields["address-input"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.typeText("example.")
    shot("search")
    field.typeText("com\n")
    XCTAssertTrue(app.buttons["bar-more"].waitForExistence(timeout: 10))
    sleep(2)

    app.buttons["bar-more"].tap()
    XCTAssertTrue(app.buttons["page-settings"].waitForExistence(timeout: 5))
    shot("page-menu")
    // Sheets have no close button: a drag down closes them.
    app.otherElements["page-menu"].swipeDown()

    app.buttons["bar-tabs"].tap()
    let settings = app.buttons["tab-switcher-settings"]
    XCTAssertTrue(settings.waitForExistence(timeout: 5))
    shot("tabs")

    settings.tap()
    XCTAssertTrue(app.buttons["settings-general"].waitForExistence(timeout: 5))
    shot("settings")
    app.buttons["settings-general"].tap()
    XCTAssertTrue(app.staticTexts["settings-page-title"].waitForExistence(timeout: 5))
    shot("settings-general")

    // Settings › General › Show welcome again.
    let again = app.buttons["settings-show-welcome"]
    for _ in 0..<6 where !again.isHittable { app.swipeUp() }
    again.tap()
    XCTAssertTrue(skip.waitForExistence(timeout: 5))
    sleep(1)
    shot("welcome")
    // A second look a moment later: the welcome moves unless Reduce Motion is on.
    shot("welcome-later")
    skip.tap()
  }
}
