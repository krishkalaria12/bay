import BayCore
import BayDesign
import CoreText
import LocalAuthentication
import SwiftUI
import UIKit

// The first launch, ported from Yab's first run (Phone/Sources/Welcome/FirstRun.swift, Apache-2.0) with Bay's pages:
// full pages on one ground, ‹, the dots and Skip at the top, a big title, one line of words, at most one real setting
// and one button. One glass object goes through every page and becomes the next page's thing: the name's letters
// squeeze into the desktop link, that becomes the field, the private field, a tab, and at the end the real search
// field. Which page follows which, the stage's numbers and the demonstrations' content come from the core
// (`welcomeForward`, `hero`, `welcomeContent`); this draws them.

/// The welcome's state: the page on screen and the pages' own life.
@MainActor
final class FirstRun: ObservableObject {
  @Published private(set) var step: WelcomeStep = .welcome
  /// The private page's glasses are on: the page is night.
  @Published private(set) var privateOn = false
  /// A finger on the name: its jelly, counted.
  @Published private(set) var pokes = 0
  /// The field page: what the field is typing, what landed in each way, and the way just lit.
  @Published private(set) var typed = ""
  @Published private(set) var landed = ["", "", ""]
  @Published private(set) var lit: Int?
  /// The links page: the tab in front, and a link on its way in from another app.
  @Published private(set) var linkShown = 0
  @Published private(set) var linkComing: Int?
  @Published private(set) var linkLanding = false
  /// The welcome is fading off the browser.
  @Published private(set) var leaving = false

  let content = welcomeContent()
  /// Asked once, as the welcome comes up: whether Bay may ask to be the default browser.
  let asksLinks = asksAboutLinks(status: DefaultBrowserStatus.current)
  let reduced = UIAccessibility.isReduceMotionEnabled
  private let strings: Strings
  /// Reveals the browser; `true` when skipped early, so the real field takes over from the glass.
  private let onDone: (Bool) -> Void
  private var loop: Task<Void, Never>?
  private var phrase = 0
  private var finished = false

  init(strings: Strings, onDone: @escaping (Bool) -> Void) {
    self.strings = strings
    self.onDone = onDone
  }

  var pages: Int { Int(welcomePageCount(asksLinks: asksLinks)) }
  var page: Int { Int(welcomePageOf(step: step, asksLinks: asksLinks)) }

  /// A view's animation, or a short fade with Reduce Motion on.
  func motion(_ animation: Animation) -> Animation {
    reduced ? .easeOut(duration: 0.2) : animation
  }

  func spring(_ spring: WelcomeSpring) -> Animation {
    motion(.spring(response: spring.response, dampingFraction: spring.dampingRatio))
  }

  var morph: Animation { spring(content.motion.morph) }

  // MARK: The way through

  func go(_ next: WelcomeStep) {
    loop?.cancel()
    withAnimation(morph) {
      step = next
      if next != .private { privateOn = false }
    }
    switch next {
    case .field: startTyping(now: false)
    case .links: startLinks()
    default: break
    }
  }

  /// The page's one button. Links ends the welcome with its own question.
  func forward() {
    if step == .links {
      Haptics.tick()
      DefaultBrowserStatus.openSetting()
      finish(openField: false)
      return
    }
    Haptics.press()
    switch welcomeForward(step: step, asksLinks: asksLinks) {
    case .to(let next): go(next)
    case .finish: finish(openField: false)
    }
  }

  func back() {
    guard let previous = welcomeBack(step: step) else { return }
    Haptics.press()
    go(previous)
  }

  func skip() {
    Haptics.press()
    finish(openField: skipOpensField(step: step))
  }

  private func finish(openField: Bool) {
    guard !finished else { return }
    finished = true
    loop?.cancel()
    if openField { go(.end) }
    // The glass reaches the field's place before the welcome fades off it.
    let after: UInt64 = openField && !reduced ? 420 : 0
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: after * 1_000_000)
      withAnimation(.easeOut(duration: reduced ? 0.15 : 0.3)) { leaving = true }
      try? await Task.sleep(nanoseconds: (reduced ? 150 : 300) * 1_000_000)
      onDone(openField)
    }
  }

  // MARK: The pages' own life

  func poke() {
    Haptics.tick()
    pokes += 1
  }

  func togglePrivate() {
    Haptics.tick()
    withAnimation(motion(.easeInOut(duration: 0.45))) { privateOn.toggle() }
  }

  func tapField() {
    Haptics.tick()
    startTyping(now: true)
  }

  /// The field types a phrase, and the phrase lands in its way: Search, Go to site or Your tabs. A tap on the field
  /// types the next one at once.
  private func startTyping(now: Bool) {
    loop?.cancel()
    typed = ""
    let phrases = content.phrases
    guard !reduced else {
      landed = phrases.prefix(3).map { strings.t($0.landed) }
      return
    }
    loop = Task { @MainActor [weak self] in
      if !now { try? await Task.sleep(nanoseconds: 500_000_000) }
      while let self, !Task.isCancelled, self.step == .field {
        let next = phrases[self.phrase % phrases.count]
        self.phrase += 1
        for letter in self.strings.t(next.typed) {
          guard !Task.isCancelled else { return }
          self.typed.append(letter)
          try? await Task.sleep(nanoseconds: 42_000_000)
        }
        try? await Task.sleep(nanoseconds: 380_000_000)
        guard !Task.isCancelled else { return }
        let way = Self.index(next.way)
        withAnimation(self.spring(self.content.motion.land)) {
          self.landed[way] = self.strings.t(next.landed)
          self.typed = ""
          self.lit = way
        }
        try? await Task.sleep(nanoseconds: 450_000_000)
        withAnimation(self.motion(.easeOut(duration: 0.3))) { self.lit = nil }
        try? await Task.sleep(nanoseconds: 900_000_000)
      }
    }
  }

  private static func index(_ way: WelcomeWay) -> Int {
    switch way {
    case .search: return 0
    case .goToSite: return 1
    case .yourTabs: return 2
    }
  }

  /// A link comes in from another app every couple of seconds and becomes the tab in front.
  private func startLinks() {
    loop?.cancel()
    guard !reduced else { return }
    let count = content.links.count
    loop = Task { @MainActor [weak self] in
      while let self, !Task.isCancelled, self.step == .links {
        try? await Task.sleep(nanoseconds: 1_100_000_000)
        guard !Task.isCancelled else { return }
        let next = (self.linkShown + 1) % count
        withAnimation(self.spring(self.content.motion.link)) {
          self.linkComing = next
          self.linkLanding = false
        }
        try? await Task.sleep(nanoseconds: 900_000_000)
        guard !Task.isCancelled else { return }
        withAnimation(self.morph) { self.linkLanding = true }
        try? await Task.sleep(nanoseconds: 380_000_000)
        withAnimation(self.motion(.easeOut(duration: 0.25))) {
          self.linkShown = next
          self.linkComing = nil
          self.linkLanding = false
        }
      }
    }
  }
}

// MARK: - The screen

/// The welcome over the browser, until it's done.
struct FirstRunView: View {
  @EnvironmentObject private var strings: Strings
  @ObservedObject var run: FirstRun
  @Environment(\.colorScheme) private var scheme
  /// The bottom block's height (words, the setting, the button): the stage above it scales down when they'd meet.
  @State private var bottom: CGFloat = 300

  var body: some View {
    let night = run.step == .private && run.privateOn
    // Night reads like dark mode: light ink on the dark ground.
    let colors = FirstRunColors.of(night ? .dark : scheme)
    ZStack {
      FirstRunGround(colors: colors, night: night)
        .opacity(run.step == .end ? 0 : 1)
        .animation(run.motion(.easeOut(duration: 0.45)), value: run.step == .end)
        .ignoresSafeArea()
      GeometryReader { proxy in
        let width = min(proxy.size.width, FirstRunLayout.column)
        screen(CGSize(width: width, height: max(1, proxy.size.height)), colors: colors)
          .frame(width: width, height: proxy.size.height)
          .frame(maxWidth: .infinity)
      }
    }
    .environment(\.colorScheme, night ? .dark : scheme)
    .environmentObject(run)
    .opacity(run.leaving ? 0 : 1)
    .onAppear { FirstRunTilt.shared.start() }
    .onDisappear { FirstRunTilt.shared.stop() }
    .accessibilityElement(children: .contain)
    .accessibilityAddTraits(.isModal)
    .accessibilityIdentifier("welcome")
  }

  private func screen(_ size: CGSize, colors: FirstRunColors) -> some View {
    let stageWidth = CGFloat(run.content.stageWidth)
    let available = size.height - bottom - FirstRunLayout.stageTop - FirstRunLayout.stageGap
    let needs = CGFloat(stageNeeds(step: run.step))
    let k = max(0.45, min(size.width / stageWidth, FirstRunLayout.maxScale, available / needs))
    // The drawing a little above the middle of the room it has.
    let air = max(0, (available - needs * k) * 0.4)
    return ZStack(alignment: .top) {
      FirstRunStage(colors: colors)
        .frame(width: stageWidth, height: CGFloat(run.content.stageHeight), alignment: .topLeading)
        .scaleEffect(k, anchor: .topLeading)
        .frame(width: stageWidth * k, height: CGFloat(run.content.stageHeight) * k, alignment: .topLeading)
        .padding(.top, FirstRunLayout.stageTop + air)
        .animation(run.morph, value: k)
        .animation(run.morph, value: air)
      VStack(spacing: 0) {
        FirstRunBar(colors: colors)
        Spacer(minLength: 0)
        FirstRunBottom(colors: colors, maxWords: max(120, size.height * 0.42))
          .background(
            GeometryReader { inner in
              Color.clear.preference(key: BottomHeight.self, value: inner.size.height)
            })
      }
      .frame(width: size.width, height: size.height)
    }
    .onPreferenceChange(BottomHeight.self) { bottom = $0 }
  }
}

private struct BottomHeight: PreferenceKey {
  static let defaultValue: CGFloat = 300
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// The page's numbers: the bar, the stage's top under it and its air above the words, the widest column (an iPad)
/// and the drawing's largest scale.
private enum FirstRunLayout {
  static let barHeight: CGFloat = 48
  static let stageTop: CGFloat = 48
  static let stageGap: CGFloat = 16
  static let column: CGFloat = 440
  static let maxScale: CGFloat = 1.1
}

/// The first run's colours: Bay's paper and ink, with the icon's evening in it. Yab draws its ground in the system's
/// blue; Bay's comes from its icon instead: the setting sun's coral glowing at the top by day, dusk's violet by night.
struct FirstRunColors {
  let ground: Color
  let groundTop: Color
  let glow: Color
  let dot: Color
  /// Titles and anything read first.
  let ink: Color
  /// The words under a title: opaque, so they keep their contrast over the glow.
  let words: Color
  /// Placeholders, the dots not on screen, hairlines.
  let faint: Color
  /// The caret, a way's light, the pen.
  let accent: Color
  let button: Color
  let buttonText: Color
  /// Tiles drifting behind the name, and the tabs behind the one in front.
  let tile: Color
  let hairline: Color

  static func of(_ scheme: ColorScheme) -> FirstRunColors { scheme == .dark ? dark : light }

  static let light = FirstRunColors(
    ground: Color(hex: 0xF4F0E8), groundTop: Color(hex: 0xF7E6DC), glow: Color(hex: 0xE8613C), dot: Color(hex: 0x1C1B19).opacity(0.06),
    ink: Color(hex: 0x1C1B19), words: Color(hex: 0x4A4741), faint: Color(hex: 0x1C1B19).opacity(0.32), accent: Color(hex: 0xE8613C),
    button: Color(hex: 0x1C1B19), buttonText: Color(hex: 0xF4F0E8), tile: .white, hairline: Color(hex: 0x1C1B19).opacity(0.1))

  static let dark = FirstRunColors(
    ground: Color(hex: 0x121216), groundTop: Color(hex: 0x1C1A2A), glow: Color(hex: 0x6A5A9A), dot: Color(hex: 0xF3F2EF).opacity(0.045),
    ink: Color(hex: 0xF3F2EF), words: Color(hex: 0xD1CDC6), faint: Color(hex: 0xF3F2EF).opacity(0.32), accent: Color(hex: 0xF0784F),
    button: Color(hex: 0xF3F2EF), buttonText: Color(hex: 0x121216), tile: Color.white.opacity(0.12), hairline: Color(hex: 0xF3F2EF).opacity(0.1))

  /// Private's night: the ground once the glasses are on.
  static let night = Color(hex: 0x060608)
  /// The green of a link's app.
  static let green = Color(hex: 0x34C759)
}

extension Color {
  init(hex: UInt32) {
    self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
  }

  /// `#RRGGBB`, as the core writes the links' colours.
  init(hexString: String) {
    self.init(hex: UInt32(hexString.dropFirst(), radix: 16) ?? 0)
  }
}

/// The ground: Bay's paper under the icon's glow, its dots barely there; Bay's night in dark mode; night once private.
private struct FirstRunGround: View {
  let colors: FirstRunColors
  let night: Bool
  @EnvironmentObject private var run: FirstRun

  var body: some View {
    ZStack {
      LinearGradient(
        stops: [.init(color: colors.groundTop, location: 0), .init(color: colors.ground, location: 0.42), .init(color: colors.ground, location: 1)],
        startPoint: .top, endPoint: .bottom)
      RadialGradient(colors: [colors.glow.opacity(0.26), colors.glow.opacity(0)], center: UnitPoint(x: 0.5, y: -0.08), startRadius: 0, endRadius: 520)
      Canvas { context, size in
        var dots = Path()
        for x in stride(from: 9.0, to: size.width, by: 18) {
          for y in stride(from: 9.0, to: size.height, by: 18) {
            dots.addEllipse(in: CGRect(x: x - 1, y: y - 1, width: 2, height: 2))
          }
        }
        context.fill(dots, with: .color(colors.dot))
      }
      .padding(-12)
      .parallax(-4)
      FirstRunColors.night
        .opacity(night ? 1 : 0)
        .animation(run.motion(.easeInOut(duration: 0.45)), value: night)
    }
    .accessibilityHidden(true)
  }
}

// MARK: - Glass

/// How a glass object reads: `clear` lets what's behind show (the field, the desktop link), `solid` hides it (a tab
/// card in front of others, the last page's field) and `night` is the private page with the glasses on.
enum WelcomeGlassTone {
  case clear, solid, night
}

/// Liquid Glass on iOS 26; before it, a thin material with the tone's tint and a hairline.
private struct WelcomeGlass<S: Shape>: ViewModifier {
  let shape: S
  let tone: WelcomeGlassTone
  @Environment(\.colorScheme) private var scheme

  func body(content: Content) -> some View {
    if #available(iOS 26, *) {
      content.glassEffect(.regular.tint(tint), in: shape)
    } else {
      content
        .background(
          ZStack {
            shape.fill(.ultraThinMaterial)
            shape.fill(tint)
            shape.stroke(Color.primary.opacity(0.08), lineWidth: 0.5)
          })
    }
  }

  private var tint: Color {
    switch tone {
    case .clear: return Color.white.opacity(scheme == .dark ? 0.08 : 0.2)
    case .solid: return scheme == .dark ? Color(red: 0.16, green: 0.16, blue: 0.18).opacity(0.95) : Color.white.opacity(0.94)
    case .night: return Color(red: 0.1, green: 0.1, blue: 0.12).opacity(0.9)
    }
  }
}

extension View {
  fileprivate func welcomeGlass<S: Shape>(_ shape: S, tone: WelcomeGlassTone = .clear) -> some View {
    modifier(WelcomeGlass(shape: shape, tone: tone))
  }
}

/// 0.96 under the finger.
private struct Pressed: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed ? 0.96 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

// MARK: - The frame: ‹, the dots, Skip

private struct FirstRunBar: View {
  let colors: FirstRunColors
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var run: FirstRun

  var body: some View {
    let back = welcomeBack(step: run.step) != nil
    let skip = run.step != .end
    HStack {
      Button(action: run.back) {
        BayIconView(.back, size: IconSize.small, color: colors.ink)
          .frame(width: 44, height: 44)
          .welcomeGlass(Circle())
      }
      .buttonStyle(Pressed())
      .opacity(back ? 1 : 0)
      .allowsHitTesting(back)
      .accessibilityLabel(Text(verbatim: strings.t("welcome.back")))
      .accessibilityIdentifier("welcome-back")
      .accessibilityHidden(!back)
      Spacer(minLength: 0)
      Button(action: run.skip) {
        BayText(strings.t("welcome.skip"), weight: .medium, color: colors.ink)
          .padding(.horizontal, Space.lg)
          .frame(minHeight: 44)
          .welcomeGlass(Capsule())
      }
      .buttonStyle(Pressed())
      .opacity(skip ? 1 : 0)
      .allowsHitTesting(skip)
      .accessibilityIdentifier("welcome-skip")
      .accessibilityHidden(!skip)
    }
    .overlay {
      HStack(spacing: 6) {
        ForEach(0..<run.pages, id: \.self) { i in
          Capsule()
            .fill(i == run.page ? colors.ink : colors.faint)
            .frame(width: i == run.page ? 22 : 7, height: 7)
        }
      }
      .animation(run.spring(run.content.motion.dots), value: run.page)
      .opacity(run.step == .end ? 0 : 1)
      .accessibilityHidden(true)
    }
    .padding(.horizontal, Space.lg)
    .padding(.top, Space.xs)
    .frame(height: FirstRunLayout.barHeight)
    .animation(run.motion(.easeOut(duration: 0.25)), value: back)
  }
}

// MARK: - The words, the setting, the button

private struct FirstRunBottom: View {
  let colors: FirstRunColors
  let maxWords: CGFloat
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var run: FirstRun
  /// The words' own height, measured off screen.
  @State private var wordsHeight: CGFloat = 0

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Group {
        // As tall as the words; only text too large for the room scrolls.
        if wordsHeight > maxWords {
          ScrollView(showsIndicators: false) { words }.frame(height: maxWords)
        } else {
          words
        }
      }
      .background(
        words.hidden().accessibilityHidden(true)
          .background(GeometryReader { proxy in Color.clear.preference(key: WordsHeight.self, value: proxy.size.height) }))
      .onPreferenceChange(WordsHeight.self) { wordsHeight = $0 }
      .id(run.step)
      .transition(
        .asymmetric(
          insertion: .opacity.combined(with: .offset(y: 8)).animation(run.motion(.easeOut(duration: 0.3).delay(0.08))),
          removal: .opacity.animation(run.motion(.easeOut(duration: 0.14)))))
      SettingRow(colors: colors)
        .padding(.top, 22)
      CallButton(colors: colors)
        .padding(.top, Space.lg)
    }
    .padding(.horizontal, Space.section)
    .padding(.bottom, 6)
    .opacity(run.step == .end ? 0 : 1)
    .animation(run.motion(.easeOut(duration: 0.2)), value: run.step == .end)
  }

  @ViewBuilder private var words: some View {
    if let keys = Self.keys(run.step) {
      VStack(alignment: .leading, spacing: 10) {
        BayText(strings.t(keys.title), variant: .display, weight: .bold, color: colors.ink)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityAddTraits(.isHeader)
          .accessibilityIdentifier("welcome-title")
        BayText(strings.t(keys.words), color: colors.words)
          .lineSpacing(3)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("welcome-words")
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 6)
      .fixedSize(horizontal: false, vertical: true)
    }
  }

  private static func keys(_ step: WelcomeStep) -> (title: String, words: String)? {
    switch step {
    case .welcome: return ("welcome.title.welcome", "welcome.words.welcome")
    case .desktop: return ("welcome.title.desktop", "welcome.words.desktop")
    case .field: return ("welcome.title.field", "welcome.words.field")
    case .private: return ("welcome.title.private", "welcome.words.private")
    case .links: return ("welcome.title.links", "welcome.words.links")
    case .end: return nil
    }
  }
}

private struct WordsHeight: PreferenceKey {
  static let defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// The page's one setting, on glass: the field page's keyboard, the private page's lock.
private struct SettingRow: View {
  let colors: FirstRunColors
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @EnvironmentObject private var run: FirstRun

  var body: some View {
    Group {
      if run.step == .field || run.step == .private {
        let keyboard = run.step == .field
        let on = keyboard ? app.preferences.openSearchOnLaunch : app.preferences.lockPrivateTabs
        let label = strings.t(keyboard ? "settings.searchOnLaunch" : "settings.lockPrivate")
        let detail = strings.t(keyboard ? "settings.searchOnLaunch.detail" : "settings.lockPrivate.detail")
        Toggle(isOn: Binding(get: { on }, set: { _ in change(keyboard: keyboard, on: on) })) {
          VStack(alignment: .leading, spacing: Space.xxs) {
            BayText(label, weight: .medium, color: colors.ink)
            BayText(detail, variant: .footnote, color: colors.words)
          }
          .fixedSize(horizontal: false, vertical: true)
        }
        .tint(BayColor.accent)
        .padding(.leading, Space.section)
        .padding(.trailing, Space.lg)
        .padding(.vertical, 10)
        .frame(minHeight: 64)
        .welcomeGlass(RoundedRectangle(cornerRadius: 30, style: .continuous))
        .accessibilityHint(Text(verbatim: detail))
        .accessibilityIdentifier(keyboard ? "welcome-keyboard" : "welcome-lock")
      }
    }
    .id(run.step)
    .transition(
      .asymmetric(
        insertion: .opacity.animation(run.motion(.easeOut(duration: 0.24).delay(0.1))),
        removal: .opacity.animation(run.motion(.easeOut(duration: 0.12)))))
  }

  private func change(keyboard: Bool, on: Bool) {
    Haptics.tick()
    if keyboard {
      app.dispatch(.preferences(update: .openSearchOnLaunch(!on)))
      return
    }
    guard !on else {
      app.dispatch(.lockPrivateTabs(enabled: false))
      return
    }
    // Turning the lock on proves Face ID, Touch ID or the passcode works before relying on it.
    let context = LAContext()
    var problem: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &problem) else { return }
    let prompt = strings.t("lock.prompt")
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: prompt) { success, _ in
      guard success else { return }
      Task { @MainActor in app.dispatch(.lockPrivateTabs(enabled: true)) }
    }
  }
}

extension PreferencesUpdate {
  /// An update that changes only whether search opens when Bay starts.
  static func openSearchOnLaunch(_ on: Bool) -> PreferencesUpdate {
    PreferencesUpdate(
      theme: nil, textSize: nil, searchSuggestions: nil, skipAmp: nil, pullToRefresh: nil, startPageAfterHours: nil, youtube: nil,
      welcomed: nil, openSearchOnLaunch: on, swipeToNavigate: nil, appLinks: nil, siteFont: nil)
  }

  /// An update that marks the welcome done.
  static var welcomedNow: PreferencesUpdate {
    PreferencesUpdate(
      theme: nil, textSize: nil, searchSuggestions: nil, skipAmp: nil, pullToRefresh: nil, startPageAfterHours: nil, youtube: nil,
      welcomed: true, openSearchOnLaunch: nil, swipeToNavigate: nil, appLinks: nil, siteFont: nil)
  }
}

/// The page's one button, in ink.
private struct CallButton: View {
  let colors: FirstRunColors
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var run: FirstRun

  var body: some View {
    let (key, id) = what
    let label = strings.t(key)
    Button(action: run.forward) {
      BayText(label, variant: .headline, color: colors.buttonText)
        .frame(maxWidth: .infinity, minHeight: 56)
        .background(colors.button, in: Capsule(style: .continuous))
        .shadow(color: .black.opacity(0.18), radius: 11, y: 8)
        .contentShape(Capsule(style: .continuous))
    }
    .buttonStyle(Pressed())
    .disabled(run.step == .end)
    .animation(run.motion(.easeOut(duration: 0.2)), value: label)
    .accessibilityIdentifier(id)
  }

  private var what: (String, String) {
    switch run.step {
    case .welcome: return ("welcome.start", "welcome-start")
    case .links: return ("welcome.makeDefault", "welcome-make-default")
    default: return ("welcome.continue", "welcome-next")
    }
  }
}

// MARK: - The stage: the drawing above the words

/// The drawing, 402 wide in its own units, its top under ‹ and Skip: the glass object and whatever the page has around
/// it. The screen scales it to fit between the bar and the words.
private struct FirstRunStage: View {
  let colors: FirstRunColors
  @EnvironmentObject private var run: FirstRun

  var body: some View {
    let step = run.step
    let rect = hero(step: step)
    ZStack(alignment: .topLeading) {
      if step == .welcome {
        DriftRows(colors: colors)
          .offset(y: 48)
          .parallax(-12)
          .transition(.opacity.animation(run.motion(.easeOut(duration: 0.3))))
          .accessibilityHidden(true)
        GlassName(colors: colors)
          .parallax(5)
          .transition(
            .asymmetric(
              insertion: .opacity.animation(run.motion(.easeOut(duration: 0.4))),
              removal: .modifier(active: Melt(from: run.content.letters, into: hero(step: .desktop)), identity: Melt(from: run.content.letters, into: nil))))
      }
      if step == .desktop {
        DesktopPicture()
          .offset(x: 31, y: 90)
          .parallax(-7)
          .transition(.opacity.combined(with: .offset(y: 14)).animation(run.motion(.easeOut(duration: 0.4))))
      }
      if step == .field {
        FieldWays(colors: colors)
          .offset(x: 20, y: 160)
          .parallax(3)
          .transition(.opacity.combined(with: .offset(y: 14)).animation(run.motion(.easeOut(duration: 0.34).delay(0.12))))
      }
      if step == .private {
        PrivateAround(colors: colors)
          .parallax(-6)
          .transition(.opacity.animation(run.motion(.easeOut(duration: 0.3))))
      }
      if step == .links {
        LinksBehind(colors: colors)
          .parallax(-8)
          .transition(.opacity.animation(run.motion(.easeOut(duration: 0.3))))
      }
      HeroGlass(colors: colors, rect: rect)
      if step == .links, let coming = run.linkComing {
        LinkPill(colors: colors, link: run.content.links[coming], landing: run.linkLanding, card: rect)
          .parallax(10)
          .transition(.opacity.combined(with: .offset(y: -16)))
      }
    }
    .frame(width: CGFloat(run.content.stageWidth), height: CGFloat(run.content.stageHeight), alignment: .topLeading)
  }
}

extension StageRect {
  fileprivate var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

/// The one glass object, in this page's shape, with this page's thing in it.
private struct HeroGlass: View {
  let colors: FirstRunColors
  let rect: StageRect
  @EnvironmentObject private var run: FirstRun

  var body: some View {
    let step = run.step
    let shape = RoundedRectangle(cornerRadius: CGFloat(rect.radius), style: .continuous)
    let tone: WelcomeGlassTone = step == .private && run.privateOn ? .night : step == .links || step == .end ? .solid : .clear
    content(step)
      .frame(width: CGFloat(rect.width), height: CGFloat(rect.height))
      .clipShape(shape)
      .welcomeGlass(shape, tone: tone)
      .offset(x: CGFloat(rect.x), y: CGFloat(rect.y))
      .parallax(6)
      // Only the fade waits for the letters to start squeezing; the shape itself moves on the page's spring.
      .opacity(step == .welcome ? 0 : 1)
      .animation(run.motion(step == .welcome ? .easeOut(duration: 0.2) : .easeOut(duration: 0.3).delay(0.12)), value: step == .welcome)
      .allowsHitTesting(step != .welcome)
  }

  @ViewBuilder private func content(_ step: WelcomeStep) -> some View {
    ZStack {
      switch step {
      case .welcome: Color.clear
      case .desktop: DesktopLink(colors: colors)
      case .field: TypingField(colors: colors)
      case .private: PrivateField(colors: colors)
      case .links: TabCard(link: run.content.links[run.linkShown], height: CGFloat(rect.height))
      case .end: EndField(colors: colors)
      }
    }
    .id(step == .links ? "links.\(run.linkShown)" : "\(step)")
    .transition(.opacity.animation(run.motion(.easeOut(duration: 0.28))))
  }
}

// MARK: - The welcome: the name in glass

/// Sites drifting by in three rows, the middle one the other way; through the glass letters they show bent.
private struct DriftRows: View {
  let colors: FirstRunColors
  @EnvironmentObject private var run: FirstRun

  var body: some View {
    TimelineView(.animation(minimumInterval: nil, paused: run.reduced)) { context in
      let t = context.date.timeIntervalSinceReferenceDate
      ZStack(alignment: .topLeading) {
        row(0, t: t, period: 26, reverse: false).offset(y: 10)
        row(4, t: t, period: 31, reverse: true).offset(y: 108)
        row(8, t: t, period: 22, reverse: false).offset(y: 206)
      }
    }
    .frame(width: CGFloat(run.content.stageWidth), height: 300, alignment: .topLeading)
    .clipped()
    .mask(
      LinearGradient(
        stops: [
          .init(color: .clear, location: 0), .init(color: .black, location: 0.14), .init(color: .black, location: 0.86),
          .init(color: .clear, location: 1),
        ], startPoint: .leading, endPoint: .trailing)
    )
    .opacity(0.6)
  }

  private func row(_ first: Int, t: Double, period: Double, reverse: Bool) -> some View {
    let sites = run.content.driftSites
    let span = CGFloat(9) * (76 + 18)
    var p = CGFloat((t / period).truncatingRemainder(dividingBy: 1))
    if run.reduced { p = 0.18 }
    if reverse { p = 1 - p }
    return HStack(spacing: 18) {
      ForEach(0..<18, id: \.self) { k in
        WelcomeSiteIcon(host: sites[(first + k % 9) % sites.count], size: 40)
          .frame(width: 76, height: 76)
          .background(colors.tile, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
          .shadow(color: Color(hex: 0x141C36).opacity(0.1), radius: 9, y: 6)
      }
    }
    .fixedSize()
    .offset(x: -p * span)
  }
}

/// A site's own icon, shipped with Bay: a fresh install has been nowhere yet, so there's no saved one.
private struct WelcomeSiteIcon: View {
  let host: String
  let size: CGFloat

  var body: some View {
    if let image = UIImage(named: "WelcomeSites/\(host)") {
      Image(uiImage: image)
        .resizable()
        .interpolation(.high)
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
    } else {
      Color.clear.frame(width: size, height: size)
    }
  }
}

/// The name in Liquid Glass: the letters refract the sites drifting under them. A finger on them: jelly.
private struct GlassName: View {
  let colors: FirstRunColors
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var run: FirstRun
  @State private var squish = CGSize(width: 1, height: 1)

  var body: some View {
    let r = run.content.letters.cgRect
    let shape = NameShape(text: strings.t("welcome.name.text"))
    ZStack(alignment: .topLeading) {
      shape
        .fill(Color(hex: 0x141C36).opacity(0.16))
        .frame(width: r.width, height: r.height)
        .blur(radius: 10)
        .offset(x: r.minX, y: r.minY + 10)
      Color.clear
        .frame(width: r.width, height: r.height)
        .welcomeGlass(shape)
        .contentShape(shape)
        .onTapGesture(perform: run.poke)
        .scaleEffect(x: squish.width, y: squish.height, anchor: .bottom)
        .offset(x: r.minX, y: r.minY)
        .accessibilityElement()
        .accessibilityLabel(Text(verbatim: strings.t("welcome.name")))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("welcome-name")
    }
    .frame(width: CGFloat(run.content.stageWidth), height: CGFloat(run.content.stageHeight), alignment: .topLeading)
    .onChange(of: run.pokes) { _ in jelly() }
  }

  /// The prototype's jelly: wider and lower, then back past rest, settling.
  private func jelly() {
    guard !run.reduced else { return }
    let frames: [(CGFloat, CGFloat, Double)] = [(1.1, 0.86, 0.1), (0.93, 1.08, 0.13), (1.04, 0.97, 0.13), (0.985, 1.015, 0.12), (1, 1, 0.22)]
    var at = 0.0
    for (x, y, duration) in frames {
      DispatchQueue.main.asyncAfter(deadline: .now() + at) {
        withAnimation(.easeInOut(duration: duration)) { squish = CGSize(width: x, height: y) }
      }
      at += duration
    }
  }
}

/// Get Started: the letters squeeze into the next page's glass and blur away while that glass grows out of them.
private struct Melt: ViewModifier {
  let from: StageRect
  let into: StageRect?

  func body(content: Content) -> some View {
    let a = from.cgRect
    let b = into?.cgRect ?? a
    content
      .scaleEffect(x: b.width / a.width, y: b.height / a.height, anchor: UnitPoint(x: a.midX / 402, y: a.midY / 560))
      .offset(x: b.midX - a.midX, y: b.midY - a.midY)
      .blur(radius: into == nil ? 0 : 8)
      .opacity(into == nil ? 1 : 0)
  }
}

/// The name as a shape: the system font's heaviest letters, kerned tight, fitted to the rect.
private struct NameShape: Shape {
  let text: String

  func path(in rect: CGRect) -> Path {
    let glyphs = Self.glyphs(text)
    let unit = glyphs.boundingBoxOfPath
    guard unit.width > 0, unit.height > 0 else { return Path() }
    let k = min(rect.width / unit.width, rect.height / unit.height)
    let x = rect.midX - unit.midX * k
    let y = rect.midY - unit.midY * k
    return Path(glyphs).applying(CGAffineTransform(a: k, b: 0, c: 0, d: k, tx: x, ty: y))
  }

  // SAFETY: shapes are drawn on the main thread only, so the cache is never touched from two at once.
  nonisolated(unsafe) private static var cache: [String: CGPath] = [:]

  private static func glyphs(_ text: String) -> CGPath {
    do {
      if let path = cache[text] { return path }
      let font = UIFont.systemFont(ofSize: 182, weight: .heavy)
      let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [.font: font, .kern: -7]))
      let path = CGMutablePath()
      for run in (CTLineGetGlyphRuns(line) as? [CTRun]) ?? [] {
        let count = CTRunGetGlyphCount(run)
        guard count > 0 else { continue }
        let attributes = CTRunGetAttributes(run) as NSDictionary
        // SAFETY: CoreText always puts the run's CTFont under this key.
        let runFont = attributes[kCTFontAttributeName as String].map { $0 as! CTFont } ?? (font as CTFont)
        var ids = [CGGlyph](repeating: 0, count: count)
        var points = [CGPoint](repeating: .zero, count: count)
        CTRunGetGlyphs(run, CFRange(location: 0, length: count), &ids)
        CTRunGetPositions(run, CFRange(location: 0, length: count), &points)
        for i in 0..<count {
          guard let glyph = CTFontCreatePathForGlyph(runFont, ids[i], nil) else { continue }
          // CoreText draws up from the baseline: flip it for the screen.
          path.addPath(glyph, transform: CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: points[i].x, ty: -points[i].y))
        }
      }
      cache[text] = path
      return path
    }
  }
}

// MARK: - The desktop

/// Bay's site, where the desktop app is.
private let baySite = "https://baybrowser.in"

/// Bay on a Mac, as its site shows it.
private struct DesktopPicture: View {
  @EnvironmentObject private var strings: Strings

  var body: some View {
    Image("WelcomeMac")
      .resizable()
      .interpolation(.high)
      .scaledToFill()
      .frame(width: 340, height: 202)
      .clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
      .shadow(color: Color(hex: 0x141C36).opacity(0.18), radius: 13, y: 18)
      .accessibilityLabel(Text(verbatim: strings.t("welcome.desktop.picture")))
  }
}

/// Under the picture: one capsule, Bay for Mac, its address and Copy.
private struct DesktopLink: View {
  let colors: FirstRunColors
  @EnvironmentObject private var strings: Strings

  var body: some View {
    HStack(spacing: Space.md) {
      Image(decorative: "bay-mark")
        .resizable()
        .frame(width: 40, height: 40)
        .clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        BayText(strings.t("welcome.desktop.app"), weight: .semibold, color: colors.ink).lineLimit(1)
        BayText(baySite.replacingOccurrences(of: "https://", with: ""), variant: .subhead, color: colors.words).lineLimit(1)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(Text(verbatim: strings.t("welcome.desktop.siteLabel")))
      Spacer(minLength: 4)
      CopyButton(text: baySite)
    }
    .padding(.horizontal, 14)
  }
}

/// Copy → Copied, with the clipboard turning into a check; back after two seconds.
private struct CopyButton: View {
  let text: String
  @EnvironmentObject private var strings: Strings
  @State private var copied = false

  var body: some View {
    let label = strings.t(copied ? "welcome.copied" : "welcome.copy")
    Button {
      UIPasteboard.general.string = text
      Haptics.press()
      withAnimation(.easeOut(duration: 0.2)) { copied = true }
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) { withAnimation(.easeOut(duration: 0.2)) { copied = false } }
    } label: {
      HStack(spacing: 6) {
        BayIconView(copied ? .check : .copy, size: IconSize.inline, color: Color(hex: 0x1C1B19))
        BayText(label, variant: .subhead, weight: .semibold, color: Color(hex: 0x1C1B19))
      }
      .padding(.horizontal, 14)
      .frame(minHeight: 36)
      .background(Color.white.opacity(0.9), in: Capsule())
      .shadow(color: .black.opacity(0.08), radius: 2, y: 1)
      .contentShape(Capsule())
    }
    .buttonStyle(Pressed())
    .accessibilityLabel(Text(verbatim: label))
    .accessibilityIdentifier("welcome-copy-link")
  }
}

// MARK: - The field and its three ways

/// The field's glyph column and its inset: the ways use the same, so glyphs and words stand in one line down.
private enum Field {
  static let glyph: CGFloat = 24
  static let inset: CGFloat = 18
  static let row: CGFloat = 64
  static let width: CGFloat = 362
}

/// The field types a phrase; the phrase lands whole in its way. A tap types the next one at once.
private struct TypingField: View {
  let colors: FirstRunColors
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var run: FirstRun

  var body: some View {
    HStack(spacing: Space.md) {
      BayIconView(.search, size: IconSize.control, color: colors.faint)
        .frame(width: Field.glyph)
      HStack(spacing: 1) {
        if run.typed.isEmpty {
          BayText(strings.t("search.placeholder"), variant: .headline, weight: .regular, color: colors.faint)
        } else {
          BayText(run.typed, variant: .headline, weight: .regular, color: colors.ink)
            .transition(.opacity.combined(with: .offset(y: 26)))
        }
        Caret(color: colors.accent)
      }
      .lineLimit(1)
      Spacer(minLength: 0)
      BayIconView(.private, size: IconSize.row, color: colors.ink)
    }
    .padding(.horizontal, Field.inset)
    .contentShape(Rectangle())
    .onTapGesture(perform: run.tapField)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text(verbatim: strings.t("search.placeholder")))
    .accessibilityAddTraits(.isButton)
    .accessibilityIdentifier("welcome-demo-field")
  }
}

private struct Caret: View {
  let color: Color
  @EnvironmentObject private var run: FirstRun

  var body: some View {
    TimelineView(.periodic(from: .now, by: 0.53)) { context in
      let on = run.reduced || Int(context.date.timeIntervalSinceReferenceDate / 0.53) % 2 == 0
      RoundedRectangle(cornerRadius: 1)
        .fill(color)
        .frame(width: 2, height: 24)
        .opacity(on ? 1 : 0)
    }
  }
}

/// Search, Go to site, Your tabs: one glass card of three rows, each a quiet glyph and its name, with the last phrase
/// it took under the name.
private struct FieldWays: View {
  let colors: FirstRunColors
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var run: FirstRun

  var body: some View {
    let ways: [(String, BayIcon)] = [
      (strings.t("welcome.way.search"), .search), (strings.t("welcome.way.go"), .link), (strings.t("welcome.way.tabs"), .tabs),
    ]
    VStack(spacing: 0) {
      ForEach(Array(ways.enumerated()), id: \.offset) { i, way in
        if i > 0 {
          Rectangle()
            .fill(colors.hairline)
            .frame(height: 0.5)
            .padding(.leading, Field.inset + Field.glyph + Space.md)
        }
        let landed = run.landed[i]
        HStack(spacing: Space.md) {
          BayIconView(way.1, size: IconSize.row, color: colors.words)
            .frame(width: Field.glyph)
          VStack(alignment: .leading, spacing: 1) {
            if landed.isEmpty {
              BayText(way.0, variant: .headline, weight: .regular, color: colors.ink)
            } else {
              BayText(way.0, variant: .footnote, weight: .semibold, color: colors.faint)
              BayText(landed, variant: .headline, weight: .regular, color: colors.ink)
                .lineLimit(1)
                .id(landed)
                .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: -22)), removal: .opacity))
            }
          }
          Spacer(minLength: 0)
        }
        .padding(.horizontal, Field.inset)
        .frame(height: Field.row)
        .background(colors.accent.opacity(run.lit == i ? 0.1 : 0))
      }
    }
    .frame(width: Field.width)
    .clipShape(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
    .welcomeGlass(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text(verbatim: ways.map(\.0).joined(separator: ", ")))
  }
}

// MARK: - Private

private let nightInk = Color.white.opacity(0.88)

/// The private page's field: tap the glasses and the page goes night.
private struct PrivateField: View {
  let colors: FirstRunColors
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var run: FirstRun

  var body: some View {
    let night = run.privateOn
    HStack(spacing: Space.md) {
      BayIconView(.search, size: IconSize.row, color: night ? Color.white.opacity(0.7) : colors.faint)
        .frame(width: Field.glyph)
      BayText(strings.t("search.placeholder"), color: night ? Color.white.opacity(0.5) : colors.faint)
        .lineLimit(1)
      Spacer(minLength: 0)
      Button(action: run.togglePrivate) {
        HStack(spacing: Space.sm) {
          BayText(strings.t("welcome.private.label"), weight: .medium, color: nightInk)
            .fixedSize()
            .frame(width: night ? nil : 0, alignment: .leading)
            .opacity(night ? 1 : 0)
            .clipped()
          BayIconView(.private, size: IconSize.control, color: night ? .white : colors.ink)
        }
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(Text(verbatim: strings.t(night ? "welcome.private.off" : "welcome.private.onLabel")))
      .accessibilityIdentifier("welcome-glasses")
    }
    .padding(.leading, Field.inset)
    .padding(.trailing, 10)
  }
}

/// Around it: "tap the glasses" in the pen, and once they're on, what private means, in chips.
private struct PrivateAround: View {
  let colors: FirstRunColors
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var run: FirstRun

  var body: some View {
    let night = run.privateOn
    let width = CGFloat(run.content.stageWidth)
    let chips = [
      [strings.t("welcome.private.chip.device"), strings.t("welcome.private.chip.closed")],
      [strings.t("welcome.private.chip.history"), strings.t("welcome.private.chip.blocked")],
    ]
    ZStack(alignment: .topLeading) {
      VStack(spacing: 10) {
        BayIconView(.private, size: 46, color: nightInk)
        BayText(strings.t("welcome.private.on"), variant: .headline, weight: .medium, color: nightInk)
      }
      .frame(width: width)
      .offset(y: 48)
      .opacity(night ? 1 : 0)
      .animation(run.motion(.easeOut(duration: 0.35).delay(night ? 0.1 : 0)), value: night)
      VStack(spacing: 10) {
        ForEach(Array(chips.enumerated()), id: \.offset) { r, row in
          HStack(spacing: Space.sm) {
            ForEach(Array(row.enumerated()), id: \.offset) { c, chip in
              BayText(chip, variant: .subhead, weight: .semibold, color: .white)
                .padding(.horizontal, 14)
                .frame(height: 34)
                .background(Color.white.opacity(0.12), in: Capsule())
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.22), lineWidth: 0.6))
                .scaleEffect(night ? 1 : 0.7)
                .opacity(night ? 1 : 0)
                .animation(
                  run.spring(run.content.motion.chips).delay(night ? 0.12 + Double(r * 2 + c) * 0.07 : 0), value: night)
            }
          }
        }
      }
      .frame(width: width)
      .offset(y: 238)
      ZStack(alignment: .topLeading) {
        Text(verbatim: strings.t("welcome.private.pen"))
          .font(PenFont.hand(26))
          .foregroundColor(colors.accent)
        PenArrow()
          .stroke(colors.accent, style: StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round))
          .frame(width: 40, height: 46)
          .offset(x: 120, y: 22)
      }
      .offset(x: 206, y: 92)
      .opacity(night ? 0 : 1)
      .animation(run.motion(.easeOut(duration: 0.3)), value: night)
    }
    .frame(width: width, height: CGFloat(run.content.stageHeight), alignment: .topLeading)
    .allowsHitTesting(false)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text(verbatim: night ? ([strings.t("welcome.private.on")] + chips.flatMap { $0 }).joined(separator: ", ") : ""))
    .accessibilityHidden(!night)
  }

  private struct PenArrow: Shape {
    func path(in rect: CGRect) -> Path {
      var path = Path()
      path.move(to: CGPoint(x: 8, y: 2))
      path.addCurve(to: CGPoint(x: 26, y: 36), control1: CGPoint(x: 18, y: 10), control2: CGPoint(x: 24, y: 20))
      path.move(to: CGPoint(x: 18, y: 30))
      path.addLine(to: CGPoint(x: 26, y: 37))
      path.addLine(to: CGPoint(x: 31, y: 28))
      return path
    }
  }
}

/// Caveat, the pen's hand (SIL OFL), registered from the bundle the first time it's drawn.
enum PenFont {
  @MainActor private static let name: String? = {
    guard let url = Bundle.main.url(forResource: "Caveat-SemiBold", withExtension: "ttf"),
      let provider = CGDataProvider(url: url as CFURL), let font = CGFont(provider)
    else { return nil }
    CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    return font.postScriptName as String?
  }()

  @MainActor static func hand(_ size: CGFloat) -> Font {
    name.map { Font.custom($0, size: size) } ?? .system(size: size, weight: .semibold)
  }
}

// MARK: - Links

/// The tabs under the one in front: straight, peeking out above it.
private struct LinksBehind: View {
  let colors: FirstRunColors

  var body: some View {
    let card = hero(step: .links)
    ZStack(alignment: .topLeading) {
      ForEach(0..<2, id: \.self) { i in
        let w = CGFloat(card.width) * (0.92 - 0.06 * CGFloat(i))
        RoundedRectangle(cornerRadius: CGFloat(card.radius), style: .continuous)
          .fill(colors.tile)
          .opacity(0.55 - 0.15 * Double(i))
          .frame(width: w, height: CGFloat(card.height))
          .offset(x: 201 - w / 2, y: CGFloat(card.y) - 12 - 11 * CGFloat(i))
          .zIndex(Double(-i))
      }
    }
    .accessibilityHidden(true)
  }
}

/// A tab: the page's picture and title, its lines, its address on glass.
private struct TabCard: View {
  let link: WelcomeLink
  let height: CGFloat
  @EnvironmentObject private var strings: Strings

  var body: some View {
    let title = strings.t(link.title)
    GeometryReader { proxy in
      VStack(spacing: 0) {
        ZStack(alignment: .bottomLeading) {
          LinearGradient(colors: link.colors.map { Color(hexString: $0) }, startPoint: .topLeading, endPoint: .bottomTrailing)
          BayText(title, variant: .title, weight: .heavy, color: .white)
            .padding(Space.lg)
        }
        .frame(height: proxy.size.height * 0.62)
        VStack(alignment: .leading, spacing: 9) {
          ForEach(0..<3, id: \.self) { i in
            Capsule()
              .fill(Color(hex: 0xECEAF1))
              .frame(width: i == 2 ? proxy.size.width * 0.5 : nil, height: 9)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        .padding(Space.lg)
        Spacer(minLength: 0)
      }
      .background(Color.white)
      .overlay(alignment: .bottom) {
        HStack(spacing: 7) {
          WelcomeSiteIcon(host: link.host, size: 14)
          BayText(link.host, variant: .footnote, color: Color(hex: 0x1C1B19))
        }
        .frame(maxWidth: .infinity, minHeight: 34)
        .welcomeGlass(Capsule())
        .padding(.horizontal, 14)
        .padding(.bottom, 12)
      }
    }
    .environment(\.colorScheme, .light)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text(verbatim: "\(title), \(link.host)"))
  }
}

/// A link on its way in from another app: a pill at the top that grows into the tab in front.
private struct LinkPill: View {
  let colors: FirstRunColors
  let link: WelcomeLink
  let landing: Bool
  let card: StageRect

  var body: some View {
    let pill = CGRect(x: 201 - 95, y: -6, width: 190, height: 40)
    let r = landing ? card.cgRect : pill
    HStack(spacing: Space.sm) {
      BayIconView(link.from == "mail" ? .share : .link, size: IconSize.inline, color: .white)
        .frame(width: 28, height: 28)
        .background(FirstRunColors.green, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      BayText(link.host, variant: .callout, weight: .medium, color: colors.ink).lineLimit(1)
      Spacer(minLength: 0)
    }
    .padding(.leading, 6)
    .padding(.trailing, 14)
    .opacity(landing ? 0 : 1)
    .frame(width: r.width, height: r.height, alignment: .leading)
    .welcomeGlass(RoundedRectangle(cornerRadius: landing ? CGFloat(card.radius) : 20, style: .continuous))
    .offset(x: r.minX, y: r.minY)
    .accessibilityHidden(true)
  }
}

/// The last page: the glass is the search field, where the real one opens.
private struct EndField: View {
  let colors: FirstRunColors
  @EnvironmentObject private var strings: Strings

  var body: some View {
    HStack(spacing: 10) {
      BayIconView(.search, size: IconSize.small, color: colors.faint)
      BayText(strings.t("search.placeholder"), variant: .callout, color: colors.faint).lineLimit(1)
      Spacer(minLength: 0)
      BayIconView(.private, size: IconSize.small, color: colors.ink)
    }
    .padding(.leading, 14)
    .padding(.trailing, 12)
    .accessibilityHidden(true)
  }
}
