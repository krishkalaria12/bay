// Search widget (B15): a WidgetKit static widget that opens Bay at `bay://search`, which JavaScript answers like
// any incoming link (B9). No data of its own: one entry, never refreshed.

import SwiftUI
import WidgetKit

struct BaySearchEntry: TimelineEntry {
  let date = Date()
}

struct BaySearchProvider: TimelineProvider {
  func placeholder(in context: Context) -> BaySearchEntry {
    BaySearchEntry()
  }

  func getSnapshot(in context: Context, completion: @escaping (BaySearchEntry) -> Void) {
    completion(BaySearchEntry())
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<BaySearchEntry>) -> Void) {
    completion(Timeline(entries: [BaySearchEntry()], policy: .never))
  }
}

struct BaySearchWidgetView: View {
  var body: some View {
    Link(destination: bayURL) {
      HStack {
        Image(systemName: "magnifyingglass")
          .font(.title3)
          .foregroundStyle(.secondary)
        Text("Search Bay")
          .foregroundStyle(.secondary)
        Spacer()
        Image(systemName: "chevron.forward")
          .foregroundStyle(.tertiary)
      }
      .padding(12)
      .background(Color(uiColor: .secondarySystemBackground))
      .clipShape(RoundedRectangle(cornerRadius: 10))
      .padding(6)
    }
  }

  private var bayURL: URL {
    URL(string: "bay://search")!
  }
}

struct BaySearchWidget: Widget {
  let kind = "BaySearchWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: BaySearchProvider()) { _ in
      BaySearchWidgetView()
    }
    .configurationDisplayName("Search Bay")
    .description("Search in Bay")
    .supportedFamilies([.systemSmall])
  }
}

@main
struct BayWidgets: WidgetBundle {
  var body: some Widget {
    BaySearchWidget()
  }
}
