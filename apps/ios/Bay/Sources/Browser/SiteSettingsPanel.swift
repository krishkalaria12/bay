import BayCore
import BayDesign
import CoreText
import SwiftUI

/// The page zoom a site can pick, in percent (the core's `TEXT_SIZE_*`).
private enum Zoom {
  static let min = 80
  static let max = 200
  static let step = 10
}

/// This site's own choices, titled with its host: what blocking did here first, then the switches for how Bay shows it
/// (the desktop site leading), its font and zoom, which kinds of blocking run here, what was downloaded from it, the
/// connection, and Bay's Settings at the foot. The font list and the blocking groups sit a step away.
struct SiteSettingsPanel: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel
  let onSettings: () -> Void
  @State private var page = Page.main

  private enum Page { case main, font, blocking }

  var body: some View {
    switch page {
    case .main: main
    case .font: fontChoices
    case .blocking: blockingChoices
    }
  }

  private var main: some View {
    let url = browser.activeUrl
    let setting = browser.siteSetting
    let blocking = browser.blocking
    let title = siteName(url: url)
    let swipe = setting.swipe ?? app.preferences.swipeToNavigate
    let changed =
      setting.textSize != nil || setting.reader || setting.desktopMode || setting.swipe != nil || setting.font != nil || setting.fullscreen
      || setting.forceDark || !setting.miniPlayer
    let downloaded = app.store.downloadsFrom(pageUrl: url)
    return PanelSheet(
      title: title, testID: "site-settings", words: strings.sheetWords(title), onClose: { browser.panel = nil },
      header: AnyView(
        HStack(spacing: Space.sm) {
          if !url.isEmpty { SiteIcon(url: url, size: 22) }
          BayText(title, variant: .headline, weight: .semibold).lineLimit(1).accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("site-settings-host")
        }
        .frame(maxWidth: .infinity, minHeight: 36)
        .environmentObject(app))
    ) {
      VStack(spacing: Space.md) {
        // What blocking did on this page, and a way to see it as the site made it: moved here from the page menu.
        if blocking != .off {
          BlockingCard(browser: browser, blocking: blocking) {
            browser.panel = nil
            browser.restoreOriginal()
          }
        }
        // How Bay behaves here, the desktop site leading.
        RowGroup {
          ActionRow(strings.t("site.desktop"), testID: "site-desktop", icon: .desktop, toggle: setting.desktopMode) {
            browser.setDesktop(!setting.desktopMode)
          }
          RowDivider()
          ActionRow(strings.t("site.forceDark"), testID: "site-force-dark", icon: .dark, badge: strings.t("site.beta"), toggle: setting.forceDark) {
            browser.changeSiteSetting { $0.forceDark = !setting.forceDark }
          }
          RowDivider()
          ActionRow(
            strings.t("site.fullscreen"), testID: "site-fullscreen", icon: .fullscreen,
            detail: setting.fullscreen ? strings.t("site.fullscreen.note") : nil, toggle: setting.fullscreen
          ) { browser.changeSiteSetting { $0.fullscreen = !setting.fullscreen } }
          RowDivider()
          // On is Anywhere, off is the edges only; Settings keeps the full choice, Off included.
          ActionRow(strings.t("site.swipeAnywhere"), testID: "site-swipe", icon: .swipe, toggle: swipe == .anywhere) {
            // Back on the global choice, the site keeps none of its own (and has nothing to reset).
            let next: SwipeMode = swipe == .anywhere ? .edges : .anywhere
            browser.changeSiteSetting { $0.swipe = next == app.preferences.swipeToNavigate ? nil : next }
          }
          RowDivider()
          ActionRow(strings.t("site.miniPlayer"), testID: "site-mini-player", icon: .pip, toggle: setting.miniPlayer) {
            browser.changeSiteSetting { $0.miniPlayer = !setting.miniPlayer }
          }
          RowDivider()
          ActionRow(strings.t("site.reader"), testID: "site-reader", icon: .reader, toggle: setting.reader) {
            browser.changeSiteSetting { $0.reader = !setting.reader }
          }
        }
        RowGroup {
          ActionRow(strings.t("site.font"), testID: "site-font", icon: .font, value: fontValue(setting.font), chevron: true) { page = .font }
          RowDivider()
          SiteZoomRow(zoom: setting.textSize.map(Int.init), global: Int(app.preferences.textSize)) { zoom in
            browser.changeSiteSetting { $0.textSize = zoom.map(Double.init) }
          }
        }
        if blocking == .on {
          RowGroup {
            ActionRow(
              strings.t("site.blockingHere"), testID: "site-blocking-groups", icon: .shield,
              value: "\(3 - setting.blockOff.count)/3", chevron: true
            ) { page = .blocking }
          }
        }
        if downloaded > 0 {
          RowGroup {
            ActionRow(
              strings.t("site.downloaded"), testID: "site-downloaded", icon: .download, tint: RowTint.downloads, value: "\(downloaded)",
              chevron: true
            ) { browser.panel = .downloads }
          }
        }
        if !url.isEmpty {
          RowGroup { Connection(secure: url.hasPrefix("https://")) }
        }
        if changed {
          RowGroup {
            ActionRow(strings.t("site.reset"), testID: "site-reset", icon: .delete, tint: RowTint.delete, destructive: true) {
              browser.changeSiteSetting { input in
                input.textSize = nil
                input.reader = false
                input.desktopMode = false
                input.swipe = nil
                input.font = nil
                input.fullscreen = false
                input.forceDark = false
                input.miniPlayer = true
              }
            }
          }
        }
        RowGroup {
          ActionRow(strings.t("site.settings"), testID: "site-bay-settings", icon: .settings, tint: RowTint.browsing, chevron: true) {
            browser.panel = nil
            onSettings()
          }
        }
      }
    }
  }

  /// The font row's value: the site's own font, or the one set for all websites.
  private func fontValue(_ font: SiteFont?) -> String {
    guard let font else { return strings.t("site.font.sameAs", ["font": strings.t(siteFontLabel(font: app.preferences.siteFont))]) }
    return strings.t(siteFontLabel(font: font))
  }

  /// The fonts, each name drawn in its own, under the one that follows all websites.
  private var fontChoices: some View {
    let title = strings.t("site.font")
    let font = browser.siteSetting.font
    return PanelSheet(
      title: title, testID: "site-settings", words: strings.sheetWords(title), onClose: { browser.panel = nil }, onBack: { page = .main }
    ) {
      // The page wouldn't take the font chosen: said here rather than failing without a word.
      if browser.fontBlocked.contains(app.activeTabId) {
        BayText(strings.t("site.font.blocked"), variant: .footnote, tone: .muted)
          .padding(.horizontal, Space.lg)
          .padding(.bottom, Space.sm)
          .accessibilityIdentifier("site-font-blocked")
      }
      RowGroup {
        FontRow(
          name: strings.t("site.font.sameAs", ["font": strings.t(siteFontLabel(font: app.preferences.siteFont))]), font: .system(size: TextVariant.body.size),
          selected: font == nil, testID: "site-font-same"
        ) { browser.changeSiteSetting { $0.font = nil } }
        ForEach(siteFonts(), id: \.self) { choice in
          RowDivider(afterIcon: false)
          FontRow(
            name: strings.t(siteFontLabel(font: choice)), font: SiteFonts.font(choice, size: TextVariant.body.size), selected: font == choice,
            testID: "site-font-\(choice)"
          ) { browser.changeSiteSetting { $0.font = choice } }
        }
      }
      BayText(strings.t("settings.siteFont.note"), variant: .footnote, tone: .muted)
        .padding(.horizontal, Space.lg)
        .padding(.top, Space.sm)
    }
  }

  /// What's blocked here, a switch per group.
  private var blockingChoices: some View {
    let title = strings.t("site.blockingHere")
    let setting = browser.siteSetting
    return PanelSheet(
      title: title, testID: "site-settings", words: strings.sheetWords(title), onClose: { browser.panel = nil }, onBack: { page = .main }
    ) {
      RowGroup {
        ForEach(Array([SiteBlockGroup.ads, .trackers, .cookies].enumerated()), id: \.offset) { index, group in
          if index > 0 { RowDivider(afterIcon: false) }
          let off = setting.blockOff.contains(group)
          ActionRow(strings.t("site.block.\(group)"), testID: "site-block-\(group)", toggle: !off) {
            browser.changeSiteSetting { input in
              input.blockOff = off ? input.blockOff.filter { $0 != group } : input.blockOff + [group]
            }
          }
        }
      }
    }
  }
}

/// A font in a list, its name set in that font, with a tick on the one chosen: here and in Settings' font for websites.
struct FontRow: View {
  let name: String
  let font: Font
  let selected: Bool
  let testID: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: Space.md) {
        Text(verbatim: name).font(font).foregroundColor(BayColor.foreground).lineLimit(1)
        Spacer(minLength: 0)
        if selected { BayIconView(.tick, size: IconSize.row, color: BayColor.accent) }
      }
      .padding(.horizontal, Space.lg)
      .padding(.vertical, Space.md)
      .frame(minHeight: Row.height)
      .contentShape(Rectangle())
    }
    .buttonStyle(.pressFeedback)
    .accessibilityLabel(Text(verbatim: name))
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier(testID)
  }
}

/// Page zoom with − and + at its end; the percentage goes back to Bay's own zoom.
private struct SiteZoomRow: View {
  @EnvironmentObject private var strings: Strings
  /// This site's own zoom, or nil while it follows Bay's.
  let zoom: Int?
  let global: Int
  let onChange: (Int?) -> Void

  var body: some View {
    let value = zoom ?? global
    HStack(spacing: 14) {
      BayIconView(.textSize, size: IconSize.small, color: .white)
        .frame(width: 29, height: 29)
        .background(RowTint.display, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      BayText(strings.t("site.zoom")).lineLimit(1)
      Spacer(minLength: 0)
      HStack(spacing: 0) {
        step(.minus, id: "site-zoom-smaller", label: strings.t("site.zoom.out"), disabled: value <= Zoom.min) {
          onChange(Swift.max(Zoom.min, value - Zoom.step))
        }
        Button { onChange(nil) } label: {
          BayText(strings.percent(value), variant: .subhead, weight: zoom == nil ? .regular : .semibold, tone: zoom == nil ? .muted : .default)
            .frame(minWidth: 52, minHeight: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(zoom == nil)
        .accessibilityLabel(Text(verbatim: strings.t("site.zoom.reset", ["size": "\(global)"])))
        .accessibilityValue(Text(verbatim: strings.percent(value)))
        .accessibilityIdentifier("site-zoom-value")
        step(.add, id: "site-zoom-larger", label: strings.t("site.zoom.in"), disabled: value >= Zoom.max) {
          onChange(Swift.min(Zoom.max, value + Zoom.step))
        }
      }
      .background(BayColor.fill, in: Capsule())
    }
    .padding(.leading, Space.lg)
    .padding(.trailing, Space.sm)
    .frame(minHeight: Row.height)
  }

  private func step(_ icon: BayIcon, id: String, label: String, disabled: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      BayIconView(icon, size: IconSize.small).frame(width: 40, height: 36)
    }
    .buttonStyle(PressFeedbackStyle())
    .disabled(disabled)
    .opacity(disabled ? 0.35 : 1)
    .accessibilityLabel(Text(verbatim: label))
    .accessibilityIdentifier(id)
  }
}

/// Whether pages from here travel encrypted: said, not tapped.
private struct Connection: View {
  @EnvironmentObject private var strings: Strings
  let secure: Bool

  var body: some View {
    let label = secure ? strings.t("site.secure") : strings.t("site.notSecure")
    let detail = secure ? strings.t("site.secure.detail") : strings.t("site.notSecure.detail")
    HStack(spacing: 14) {
      BayIconView(.lock, size: IconSize.small, color: .white)
        .frame(width: 29, height: 29)
        .background(secure ? RowTint.blocking : RowTint.delete, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      VStack(alignment: .leading, spacing: 1) {
        BayText(label, tone: secure ? .default : .danger)
        BayText(detail, variant: .subhead, tone: .muted)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, Space.lg)
    .padding(.vertical, Space.md)
    .frame(minHeight: Row.height)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text(verbatim: label))
    .accessibilityValue(Text(verbatim: detail))
    .accessibilityIdentifier("site-connection")
  }
}

/// The fonts Bay bundles for pages (packages/mobile-core/design/fonts): each file's bytes as base64 for the page
/// script, read once, and the font itself for drawing a font's name in the pickers.
@MainActor
enum SiteFonts {
  /// OpenType's weight axis, `wght`.
  private static let wghtAxis: UInt32 = 0x7767_6874
  private static var encoded: [String: String] = [:]
  private static var drawn: [SiteFont: CTFontDescriptor?] = [:]

  /// The page script's `faces` for a font: its files, each with its style and weight.
  static func faces(_ face: SiteFontFace) -> [[String: Any]] {
    face.files.compactMap { file in
      guard let data = base64(file.file) else { return nil }
      return ["data": data, "italic": file.italic, "weight": file.weight]
    }
  }

  private static func base64(_ file: String) -> String? {
    if let known = encoded[file] { return known }
    guard let data = bytes(file) else { return nil }
    let text = data.base64EncodedString()
    encoded[file] = text
    return text
  }

  private static func bytes(_ file: String) -> Data? {
    let name = (file as NSString).deletingPathExtension
    let type = (file as NSString).pathExtension
    return Bundle.main.url(forResource: name, withExtension: type).flatMap { try? Data(contentsOf: $0) }
  }

  /// A font's name in that font: the bundled upright file read by CoreText, or the system font where there's none
  /// (Original, System) or CoreText can't read it.
  static func font(_ font: SiteFont, size: CGFloat) -> Font {
    if drawn[font] == nil {
      let file = siteFontFace(font: font).files.first { !$0.italic }
      let descriptors = file.flatMap { bytes($0.file) }.flatMap { CTFontManagerCreateFontDescriptorsFromData($0 as CFData) as? [CTFontDescriptor] }
      drawn[font] = .some(descriptors?.first)
    }
    guard let descriptor = drawn[font] ?? nil else { return .system(size: size) }
    // A variable font opens at its lightest; names read at the regular weight. A fixed one ignores the axis.
    let regular = CTFontDescriptorCreateCopyWithVariation(descriptor, NSNumber(value: wghtAxis), 400)
    return Font(CTFontCreateWithFontDescriptor(regular, size, nil))
  }
}
