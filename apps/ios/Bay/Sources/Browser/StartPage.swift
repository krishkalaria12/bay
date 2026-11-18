import BayCore
import BayDesign
import SwiftUI

/// A greeting, the pinned sites and the last few pages, over the wallpaper above "Tap to search".
struct StartPage: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  let onOpen: (String) -> Void
  let onUnpin: (PinnedSite) -> Void

  private static let pinCount = 8
  private static let columns = 4
  private static let pinTile: CGFloat = 64
  private static let pinIcon: CGFloat = 32
  private static let recentCount = 3
  private static let recentIcon: CGFloat = 28
  /// Below this height the greeting gives its room to a full grid of pins and the recent pages.
  private static let roomForGreeting: CGFloat = 700

  var body: some View {
    let essentials = Array(app.pins.filter { $0.kind == .essential }.prefix(Self.pinCount))
    let recent = recentPages(pins: essentials)
    GeometryReader { geometry in
      let width = geometry.size.width - Space.gutter * 2
      let columnGap = max((width - Self.pinTile * CGFloat(Self.columns)) / CGFloat(Self.columns - 1), Space.sm)
      let greet = UIScreen.main.bounds.height >= Self.roomForGreeting || essentials.count <= Self.columns || recent.isEmpty
      VStack(alignment: .leading, spacing: Space.section) {
        Spacer(minLength: 0)
        if greet { greeting }
        if !essentials.isEmpty { pins(essentials, columnGap: columnGap) }
        if !recent.isEmpty { recentList(recent) }
      }
      .padding(.horizontal, Space.gutter)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("start-page")
  }

  /// The latest page of each site that isn't pinned, newest first.
  private func recentPages(pins: [PinnedSite]) -> [HistoryEntry] {
    var seen = Set(pins.map { siteName(url: $0.url) })
    var recent: [HistoryEntry] = []
    for entry in app.recentHistory where recent.count < Self.recentCount {
      let site = siteName(url: entry.url)
      if seen.insert(site).inserted { recent.append(entry) }
    }
    return recent
  }

  private var greeting: some View {
    TimelineView(.everyMinute) { context in
      let hour = Calendar.current.component(.hour, from: context.date)
      let key = (5..<12).contains(hour) ? "start.morning" : (12..<17).contains(hour) ? "start.afternoon" : "start.evening"
      let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: strings.locale)
        formatter.setLocalizedDateFormatFromTemplate("EEEEdMMMM")
        return formatter
      }()
      let date = formatter.string(from: context.date)
      VStack(alignment: .leading, spacing: 0) {
        BayText(strings.t(key), variant: .display)
        BayText(date, variant: .subhead, weight: .medium, tone: .muted)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(Text(verbatim: "\(strings.t(key)), \(date)"))
      .accessibilityAddTraits(.isHeader)
      .accessibilityIdentifier("start-greeting")
    }
  }

  private func pins(_ pins: [PinnedSite], columnGap: CGFloat) -> some View {
    let grid = Array(repeating: GridItem(.fixed(Self.pinTile), spacing: columnGap), count: Self.columns)
    return LazyVGrid(columns: grid, alignment: .leading, spacing: Space.lg) {
      ForEach(Array(pins.enumerated()), id: \.element.id) { index, site in
        let name = site.title.isEmpty ? siteName(url: site.url) : site.title
        VStack(spacing: Space.sm) {
          SiteIcon(url: site.url, size: Self.pinIcon, bare: true)
            .frame(width: Self.pinTile, height: Self.pinTile)
            .baySurface(radius: Radius.tile)
          BayText(name, variant: .caption).lineLimit(1).frame(width: Self.pinTile + columnGap - Space.xs)
        }
        .contentShape(Rectangle())
        .onTapGesture { onOpen(site.url) }
        .onLongPressGesture { onUnpin(site) }
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(Text(verbatim: strings.t("start.openSite", ["name": name])))
        .accessibilityHint(Text(verbatim: strings.t("start.longPressToUnpin")))
        .accessibilityAction { onOpen(site.url) }
        .accessibilityIdentifier("start-pin-\(index)")
      }
    }
  }

  private func recentList(_ recent: [HistoryEntry]) -> some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      BayText(strings.t("start.recent"), variant: .footnote, weight: .semibold, tone: .muted)
      VStack(spacing: 0) {
        ForEach(Array(recent.enumerated()), id: \.element.url) { index, entry in
          if index > 0 {
            Rectangle().fill(BayColor.foreground.opacity(0.1)).frame(height: 1 / UIScreen.main.scale)
              .padding(.leading, Space.lg + Self.recentIcon + Space.md)
          }
          let name = entry.title.isEmpty ? siteName(url: entry.url) : entry.title
          Button {
            onOpen(entry.url)
          } label: {
            HStack(spacing: Space.md) {
              SiteIcon(url: entry.url, size: Self.recentIcon)
              VStack(alignment: .leading, spacing: 0) {
                BayText(name, variant: .callout, weight: .medium).lineLimit(1)
                BayText(siteName(url: entry.url), variant: .footnote, tone: .muted).lineLimit(1)
              }
              Spacer(minLength: 0)
            }
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.sm)
            .frame(minHeight: Row.height)
          }
          .buttonStyle(.pressFeedback)
          .accessibilityLabel(Text(verbatim: strings.t("start.openSite", ["name": name])))
          .accessibilityIdentifier("start-recent-\(index)")
        }
      }
      .padding(.vertical, Space.xs)
      .baySurface(radius: Radius.card)
    }
  }
}
