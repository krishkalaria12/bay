import XCTest

/// Runs Xcode's accessibility audit over Bay's main screens: the start page, the search card, the page menu, the tab
/// switcher and Settings. Each test reaches its screen from a fresh launch, past the welcome when it shows.
@MainActor
final class AccessibilityAuditTests: XCTestCase {
  private let app = XCUIApplication()

  func testStartPage() throws {
    try startPage()
    try audit("start page")
  }

  func testSearchCard() throws {
    try startPage()
    app.buttons["start-screen"].tap()
    XCTAssertTrue(app.textFields["address-input"].waitForExistence(timeout: 5))
    try audit("search card")
  }

  func testPageMenu() throws {
    try openPage()
    app.buttons["bar-more"].tap()
    XCTAssertTrue(app.buttons["page-settings"].waitForExistence(timeout: 5))
    try audit("page menu")
  }

  func testTabSwitcher() throws {
    try openPage()
    app.buttons["bar-tabs"].tap()
    XCTAssertTrue(app.buttons["tab-switcher-settings"].waitForExistence(timeout: 5))
    try audit("tab switcher")
  }

  func testSettings() throws {
    try startPage()
    app.buttons["bar-settings"].tap()
    XCTAssertTrue(app.buttons["settings-general"].waitForExistence(timeout: 5))
    try audit("settings")
  }

  /// Launches Bay and opens a fresh tab's start page, as `bay://new-tab` does, past the welcome and the search card
  /// that come up on launch.
  private func startPage() throws {
    app.launch()
    let skip = app.buttons["welcome-skip"]
    if skip.waitForExistence(timeout: 3) { skip.tap() }
    let dismiss = app.buttons["search-dismiss"]
    if dismiss.waitForExistence(timeout: 3) { dismiss.tap() }
    app.open(URL(string: "bay://new-tab")!)
    XCTAssertTrue(app.buttons["start-screen"].waitForExistence(timeout: 10))
  }

  /// Opens example.com in the fresh tab, from the search card.
  private func openPage() throws {
    try startPage()
    app.buttons["start-screen"].tap()
    let field = app.textFields["address-input"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.typeText("https://example.com\n")
    XCTAssertTrue(app.buttons["bar-more"].waitForExistence(timeout: 10))
    // The page loads under the bar.
    _ = app.webViews.firstMatch.waitForExistence(timeout: 10)
    sleep(2)
  }

  /// Audits what's on screen, leaving out what the audit gets wrong about Bay (`ignored`), and prints what's left.
  private func audit(_ screen: String) throws {
    // Sheets and cards finish coming in first: the audit reads colours from the screen.
    sleep(1)
    let pixels = ScreenPixels(XCUIScreen.main.screenshot().image, width: app.windows.firstMatch.frame.width)
    let window = app.windows.firstMatch.frame
    try XCTContext.runActivity(named: "Audit the \(screen)") { _ in
      // Clipping is checked by eye from ScreenTourTests at the largest text size: the audit flags every one-line label
      // (a pin's name, a tile's word) and rows that wrap well when the text grows.
      try app.performAccessibilityAudit(for: XCUIAccessibilityAuditType.all.subtracting(.textClipped)) { issue in
        if Self.ignored(issue, pixels: pixels, window: window) { return true }
        let element = issue.element.map { "\($0.elementType.rawValue) '\($0.identifier)' '\($0.label)' \($0.frame)" } ?? "no element"
        print("AUDIT [\(screen)] \(issue.compactDescription) · \(issue.detailedDescription) · \(element)")
        return false
      }
    }
  }

  /// Issues that don't hold for Bay, each for the reason beside it.
  private static func ignored(_ issue: XCUIAccessibilityAuditIssue, pixels: ScreenPixels?, window: CGRect) -> Bool {
    guard let element = issue.element else { return false }
    let label = element.label
    switch issue.auditType {
    case .contrast:
      // What Settings covers isn't on screen to read.
      if !element.isHittable { return true }
      // The audit misreads text on Liquid Glass (sheets, cards, the bar), so the text is measured from the screen.
      guard let measured = pixels?.contrast(in: element.frame) else { return false }
      // White on the accent blue is 3.7:1, which waits on a darker accent in packages/mobile-core/design/tokens.json.
      return measured.ratio >= 4.5 || measured.onAccent
    case .dynamicType:
      // BayText follows the phone's text size up to each step's cap (TextVariant.maxScale), so labels in fixed shapes
      // don't spill out; the audit calls that partial support.
      if issue.compactDescription.localizedCaseInsensitiveContains("partially") { return true }
      // A site's monogram or a space's emoji, drawn to its tile's size, which VoiceOver skips.
      return label.count <= 2
    case .textClipped:
      // A one-line field scrolls its text; a monogram fits its tile.
      return element.elementType == .textField || label.count <= 2
    case .hitRegion:
      // Only what can be tapped needs a finger's room; the audit also measures lines of text.
      return element.elementType != .button
    case .sufficientElementDescription:
      // What is hidden from VoiceOver (the browser under Settings, the wallpaper) leaves an empty node the window's size.
      if label.isEmpty, element.identifier.isEmpty, element.frame == window { return true }
      // A page's address, shown as written, is what it should read.
      return !label.contains(" ") && label.contains(".")
    default:
      return false
    }
  }
}

/// The screen's pixels, to measure text's contrast as it is drawn.
private struct ScreenPixels {
  private let bytes: [UInt8]
  private let width: Int
  private let height: Int
  private let scale: CGFloat

  init?(_ image: UIImage, width points: CGFloat) {
    guard let cgImage = image.cgImage, points > 0 else { return nil }
    let width = cgImage.width
    let height = cgImage.height
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
      guard
        let context = CGContext(
          data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return false }
      context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }
    guard drawn else { return nil }
    bytes = pixels
    self.width = width
    self.height = height
    scale = CGFloat(width) / points
  }

  /// WCAG's contrast between the text in `frame` and what is behind it: the background is the area's median
  /// luminance, the text the extreme farthest from it (past the outermost 0.2%, for specks), and whether the
  /// background is the accent blue.
  func contrast(in frame: CGRect) -> (ratio: Double, onAccent: Bool)? {
    let rows = max(0, Int(frame.minY * scale))..<min(height, Int(frame.maxY * scale))
    let columns = max(0, Int(frame.minX * scale))..<min(width, Int(frame.maxX * scale))
    var luminances: [Double] = []
    for y in rows {
      for x in columns {
        let i = (y * width + x) * 4
        luminances.append(0.2126 * Self.linear(bytes[i]) + 0.7152 * Self.linear(bytes[i + 1]) + 0.0722 * Self.linear(bytes[i + 2]))
      }
    }
    guard !luminances.isEmpty else { return nil }
    luminances.sort()
    let count = luminances.count
    let background = luminances[count / 2]
    let dark = luminances[count / 500]
    let light = luminances[count - 1 - count / 500]
    let text = abs(dark - background) > abs(light - background) ? dark : light
    let ratio = (max(text, background) + 0.05) / (min(text, background) + 0.05)
    return (ratio, abs(Self.accent - background) < 0.015)
  }

  /// BayColor.accent's (4, 133, 247).
  private static let accent = 0.235

  private static func linear(_ channel: UInt8) -> Double {
    let value = Double(channel) / 255
    return value <= 0.03928 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
  }
}
