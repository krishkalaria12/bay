import BayCore
import BayDesign
import SwiftUI

/// The page zoom a site can pick, in percent (the core's `TEXT_SIZE_*`).
private enum Zoom {
  static let min = 80
  static let max = 200
  static let step = 10
}

/// This site's own choices, as Settings draws its pages: its zoom, desktop page and blocking first, then how Bay behaves
/// here, what was downloaded from it, the connection, and Bay's Settings at the foot.
struct SiteSettingsPanel: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel
  let onSettings: () -> Void
  // Swipe's choices sit one step away, so the sheet fits without scrolling.
  @State private var swipePage = false

  var body: some View {
    if swipePage {
      swipeChoices
    } else {
      main
    }
  }

  private var main: some View {
    let url = browser.activeUrl
    let setting = browser.siteSetting
    let blocking = browser.blocking
    let title = strings.t("site.title")
    let changed = setting.textSize != nil || setting.reader || setting.desktopMode || setting.swipe != nil
    let downloaded = app.store.downloadsFrom(pageUrl: url)
    return PanelSheet(
      title: title, testID: "site-settings", words: strings.sheetWords(title), onClose: { browser.panel = nil },
      header: AnyView(
        HStack(spacing: 10) {
          if !url.isEmpty { SiteIcon(url: url, size: 30) }
          BayText(siteName(url: url), variant: .headline).lineLimit(1).accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("site-settings-host")
        }
        .environmentObject(app))
    ) {
      VStack(spacing: Space.md) {
        RowGroup {
          SiteZoomRow(zoom: setting.textSize.map(Int.init), global: Int(app.preferences.textSize)) { zoom in
            browser.changeSiteSetting { $0.textSize = zoom.map(Double.init) }
          }
          RowDivider()
          ActionRow(strings.t("site.desktop"), testID: "site-desktop", icon: .desktop, tint: RowTint.language, toggle: setting.desktopMode) {
            browser.setDesktop(!setting.desktopMode)
          }
          if blocking != .off {
            RowDivider()
            ActionRow(
              strings.t("pageMenu.blocking"), testID: "site-blocking", icon: .shield, tint: RowTint.blocking,
              detail: blocking == .paused
                ? strings.t("pageMenu.blocking.paused") : blocking == .restored ? strings.t("pageMenu.blocking.restored") : nil,
              toggle: blocking == .on, action: browser.toggleBlocking)
          }
        }
        if blocking == .on {
          RowGroup(strings.t("site.blockingHere")) {
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
        RowGroup(strings.t("site.bayHere")) {
          ActionRow(strings.t("site.reader"), testID: "site-reader", icon: .reader, tint: RowTint.bookmarks, toggle: setting.reader) {
            browser.changeSiteSetting { $0.reader = !setting.reader }
          }
          RowDivider()
          ActionRow(
            strings.t("settings.swipe"), testID: "site-swipe", icon: .back, tint: RowTint.browsing,
            value: strings.t("settings.swipe.\(setting.swipe ?? app.preferences.swipeToNavigate)"), chevron: true
          ) { swipePage = true }
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

  private var swipeChoices: some View {
    let title = strings.t("settings.swipe")
    let swipe = browser.siteSetting.swipe
    let global = app.preferences.swipeToNavigate
    return PanelSheet(
      title: title, testID: "site-settings", words: strings.sheetWords(title), onClose: { browser.panel = nil },
      onBack: { swipePage = false }
    ) {
      RowGroup {
        ActionRow(
          strings.t("site.swipe.follow", ["mode": strings.t("settings.swipe.\(global)")]), testID: "site-swipe-follow", selected: swipe == nil
        ) { browser.changeSiteSetting { $0.swipe = nil } }
        ForEach([SwipeMode.anywhere, .edges, .off], id: \.self) { mode in
          RowDivider(afterIcon: false)
          ActionRow(strings.t("settings.swipe.\(mode)"), testID: "site-swipe-\(mode)", selected: swipe == mode) {
            browser.changeSiteSetting { $0.swipe = mode }
          }
        }
      }
      BayText(strings.t("site.swipe.note"), variant: .footnote, tone: .muted)
        .padding(.horizontal, Space.lg)
        .padding(.top, Space.sm)
        .accessibilityIdentifier("site-swipe-note")
    }
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
          BayText("\(value)%", variant: .subhead, weight: zoom == nil ? .regular : .semibold, tone: zoom == nil ? .muted : .default)
            .frame(minWidth: 52, minHeight: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(zoom == nil)
        .accessibilityLabel(Text(verbatim: strings.t("site.zoom.reset", ["size": "\(global)"])))
        .accessibilityValue(Text(verbatim: "\(value)%"))
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
