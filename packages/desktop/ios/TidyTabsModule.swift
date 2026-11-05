import ExpoModulesCore
@_weakLinked import FoundationModels

/// Tidy Tabs on the Mac's own Apple Intelligence model: free, and nothing leaves the Mac. It reads a list of tab titles
/// and proposes named groups; packages/core/src/tidyTabs.ts writes that list and checks the answer. Where the model
/// can't run the app groups by site instead.
public class TidyTabsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BayTidyTabs")

    // A function, not a constant: Apple Intelligence can be turned on, or finish downloading, while Bay runs.
    Function("modelStatus") { () -> String in Self.status() }

    AsyncFunction("group") { (prompt: String) async -> [[String: Any]]? in
      guard Self.status() == "available", #available(macOS 26.0, *) else { return nil }
      do {
        let session = LanguageModelSession(instructions: Self.instructions)
        let answer = try await session.respond(to: prompt, generating: TidyTabsAnswer.self, options: GenerationOptions(sampling: .greedy))
        return answer.content.groups.map { ["name": $0.name, "tabs": $0.tabs] }
      } catch {
        // The model can refuse, be busy or find the list too long; the app falls back on grouping by site.
        return nil
      }
    }

    View(TidySquiggleView.self) {
      Prop("running") { (view: TidySquiggleView, running: Bool) in view.running = running }
      Prop("color") { (view: TidySquiggleView, hex: String) in view.color = NSColor(hex: hex) }
    }
  }

  /// Where Apple Intelligence stands on this Mac. BAY_TIDY_MODEL_STATUS stands in another answer in a test copy.
  private static func status() -> String {
    if let forced = ProcessInfo.processInfo.environment["BAY_TIDY_MODEL_STATUS"] { return forced }
    guard #available(macOS 26.0, *) else { return "needsNewerMacOS" }
    switch SystemLanguageModel.default.availability {
    case .available: return "available"
    case .unavailable(.appleIntelligenceNotEnabled): return "off"
    case .unavailable(.modelNotReady): return "preparing"
    case .unavailable(.deviceNotEligible): return "ineligible"
    case .unavailable: return "unavailable"
    }
  }

  // The worked example matters: without it this model made a group per tab, or filed everything left over in the last.
  private static let instructions = """
    You sort a person's open browser tabs into groups, like tidying loose papers into labelled folders.
    Read each tab's title and put tabs about the same subject, task or project together, even when they come from different websites.
    Make two to six groups. Every group holds at least two tabs. A tab that is alone on its subject belongs in no group: leave its id out.
    Never put a tab in a group because there was nowhere else for it.
    Name each group with its subject in one to three words, never a website's name.

    Example tabs:
    0: Hotels in Rome (booking.com)
    1: Sprint board (trello.com)
    2: Rome in 3 days (lonelyplanet.com)
    3: Fix login bug · Pull Request #12 (github.com)
    4: Weather (weather.com)
    5: Login crash report (sentry.io)
    Example answer: "Trip to Rome" has 0 and 2; "Login Bug" has 3 and 5. Tabs 1 and 4 are in no group.
    """
}

@available(macOS 26.0, *)
@Generable
struct TidyTabsAnswer {
  @Guide(description: "The groups, each with a name and the ids of its tabs")
  var groups: [TidyTabsGroup]
}

@available(macOS 26.0, *)
@Generable
struct TidyTabsGroup {
  @Guide(description: "What the tabs have in common, like a folder name: 'Planets', 'Trip to Lisbon', 'Bay Pull Requests'")
  var name: String
  @Guide(description: "Ids of every tab that belongs in this group")
  var tabs: [Int]
}

/// The sidebar's divider while the model works: the line becomes a sine wave travelling left, and flattens back when the
/// answer is in. Numbers measured on Arc 1.171 (SquiggleDivider): 12.75 pt period, 3 pt high, 5 periods a second, 0.4 s in
/// and out.
final class TidySquiggleView: ExpoView {
  private static let period: CGFloat = 12.75
  private static let amplitude: CGFloat = 3
  private static let cyclesPerSecond = 5.0
  private static let ramp = 0.4

  private let wave = CAShapeLayer()

  var running = false {
    didSet {
      if running != oldValue { update(animated: true) }
    }
  }
  var color: NSColor? {
    didSet { wave.strokeColor = color?.cgColor }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    wantsLayer = true
    layer?.masksToBounds = true
    wave.fillColor = nil
    wave.lineWidth = 1
    wave.lineCap = .round
    wave.actions = ["position": NSNull(), "bounds": NSNull(), "path": NSNull(), "strokeColor": NSNull()]
    layer?.addSublayer(wave)
  }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override func setFrameSize(_ newSize: NSSize) {
    let changed = newSize != frame.size
    super.setFrameSize(newSize)
    guard changed else { return }
    wave.frame = CGRect(x: 0, y: 0, width: newSize.width + 2 * Self.period, height: newSize.height)
    update(animated: false)
  }

  /// One point per 0.5 pt, the same count flat or waving, so the path can animate point by point.
  private func path(amplitude: CGFloat) -> CGPath {
    let path = CGMutablePath()
    let mid = wave.bounds.height / 2
    path.move(to: CGPoint(x: 0, y: mid))
    var x: CGFloat = 0
    while x <= wave.bounds.width {
      path.addLine(to: CGPoint(x: x, y: mid + amplitude * sin(2 * .pi * x / Self.period)))
      x += 0.5
    }
    return path
  }

  private func update(animated: Bool) {
    guard wave.bounds.width > 0 else { return }
    let flat = path(amplitude: 0)
    let full = path(amplitude: Self.amplitude)
    let target = running ? full : flat
    if animated {
      let change = CABasicAnimation(keyPath: "path")
      change.fromValue = wave.presentation()?.path ?? (running ? flat : full)
      change.toValue = target
      change.duration = Self.ramp
      wave.add(change, forKey: "amplitude")
    }
    wave.path = target
    guard running else { return }
    let travel = CABasicAnimation(keyPath: "transform.translation.x")
    travel.fromValue = 0
    travel.toValue = -Self.period
    travel.duration = 1 / Self.cyclesPerSecond
    travel.repeatCount = .infinity
    wave.add(travel, forKey: "travel")
  }
}
