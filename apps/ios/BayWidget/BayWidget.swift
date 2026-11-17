// Bay's widgets (B15, C7): search, voice and private browsing from the home screen and the Lock Screen. Each button
// opens Bay at a `bay://` command (search, voice, private-tab), which JavaScript answers like any incoming link (B9).
// No data of their own: one entry, never refreshed. The colours are Bay's own "Bay" wallpaper.

import AppIntents
import SwiftUI
import WidgetKit

struct BayEntry: TimelineEntry {
  let date = Date()
}

struct BayProvider: TimelineProvider {
  func placeholder(in context: Context) -> BayEntry {
    BayEntry()
  }

  func getSnapshot(in context: Context, completion: @escaping (BayEntry) -> Void) {
    completion(BayEntry())
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<BayEntry>) -> Void) {
    completion(Timeline(entries: [BayEntry()], policy: .never))
  }
}

private enum BayLink {
  static let search = URL(string: "bay://search")!
  static let voice = URL(string: "bay://voice")!
  static let privateTab = URL(string: "bay://private-tab")!
}

/// The "Bay" wallpaper's sky, in light and dark.
private struct BayBackground: View {
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    LinearGradient(
      colors: scheme == .dark
        ? [Color(red: 0.06, green: 0.11, blue: 0.16), Color(red: 0.08, green: 0.13, blue: 0.17), Color(red: 0.14, green: 0.11, blue: 0.14)]
        : [Color(red: 0.72, green: 0.83, blue: 0.92), Color(red: 0.85, green: 0.89, blue: 0.94), Color(red: 0.93, green: 0.87, blue: 0.85)],
      startPoint: .top,
      endPoint: .bottom
    )
  }
}

/// The search capsule: tapping it opens Bay ready to type.
private struct SearchCapsule: View {
  var label: String

  var body: some View {
    Button(intent: OpenURLIntent(BayLink.search)) {
      HStack(spacing: 8) {
        Image(systemName: "magnifyingglass").font(.system(size: 15, weight: .semibold))
        Text(label).font(.system(size: 15, weight: .medium))
        Spacer(minLength: 0)
      }
      .foregroundStyle(.secondary)
      .padding(.horizontal, 14)
      .frame(maxWidth: .infinity, minHeight: 40)
      .background(.background.opacity(0.85), in: Capsule())
    }
    .buttonStyle(.plain)
  }
}

/// A round button with a symbol, and a label under it in the medium widget.
private struct RoundButton: View {
  var symbol: String
  var label: String?
  var url: URL

  var body: some View {
    Button(intent: OpenURLIntent(url)) {
      VStack(spacing: 6) {
        Image(systemName: symbol)
          .font(.system(size: 17, weight: .semibold))
          .frame(width: 42, height: 42)
          .background(.background.opacity(0.85), in: Circle())
        if let label {
          Text(label).font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
        }
      }
      .foregroundStyle(.primary)
    }
    .buttonStyle(.plain)
  }
}

struct BaySmallView: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Bay").font(.system(size: 17, weight: .bold))
      Spacer(minLength: 0)
      SearchCapsule(label: String(localized: "Search"))
      HStack {
        RoundButton(symbol: "mic.fill", label: nil, url: BayLink.voice)
        Spacer(minLength: 0)
        RoundButton(symbol: "eyeglasses", label: nil, url: BayLink.privateTab)
      }
    }
    .containerBackground(for: .widget) { BayBackground() }
  }
}

struct BayMediumView: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Bay").font(.system(size: 17, weight: .bold))
      SearchCapsule(label: String(localized: "Search or enter address"))
      HStack(spacing: 24) {
        RoundButton(symbol: "magnifyingglass", label: String(localized: "Search"), url: BayLink.search)
        RoundButton(symbol: "mic.fill", label: String(localized: "Voice"), url: BayLink.voice)
        RoundButton(symbol: "eyeglasses", label: String(localized: "Private"), url: BayLink.privateTab)
        Spacer(minLength: 0)
      }
    }
    .containerBackground(for: .widget) { BayBackground() }
  }
}

/// The Lock Screen's round widget: the search glass. The whole widget is one tap.
struct BayCircularView: View {
  var body: some View {
    ZStack {
      AccessoryWidgetBackground()
      Image(systemName: "magnifyingglass").font(.system(size: 20, weight: .semibold))
    }
    .widgetURL(BayLink.search)
    .containerBackground(for: .widget) { Color.clear }
  }
}

/// The Lock Screen's wide widget: a search field to tap.
struct BayRectangularView: View {
  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: "magnifyingglass")
      Text(String(localized: "Search Bay")).font(.headline)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 10)
    .frame(maxHeight: .infinity)
    .background(AccessoryWidgetBackground().clipShape(Capsule()))
    .widgetURL(BayLink.search)
    .containerBackground(for: .widget) { Color.clear }
  }
}

struct BayWidgetView: View {
  @Environment(\.widgetFamily) private var family

  var body: some View {
    switch family {
    case .systemMedium: BayMediumView()
    case .accessoryCircular: BayCircularView()
    case .accessoryRectangular: BayRectangularView()
    default: BaySmallView()
    }
  }
}

struct BaySearchWidget: Widget {
  // The kind stays the first widget's, so a search widget already on a home screen keeps working.
  let kind = "BaySearchWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: BayProvider()) { _ in
      BayWidgetView()
    }
    .configurationDisplayName("Bay")
    .description(String(localized: "Search, speak or go private in Bay."))
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
  }
}

@main
struct BayWidgets: WidgetBundle {
  var body: some Widget {
    BaySearchWidget()
  }
}
