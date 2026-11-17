import BayCore
import SwiftUI

@main
struct BayApp: App {
  @StateObject private var strings = Strings()
  @StateObject private var model = AppModel()
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      StoreCheckView()
        .environmentObject(strings)
        .environmentObject(model)
    }
    .onChange(of: scenePhase) { phase in
      if phase == .background {
        model.dispatch(.left(now: AppModel.now()))
        model.flush()
      }
    }
  }
}

/// A stand-in screen until the browser screen lands (plan N4): the space's tabs from the core's store, and a button
/// that adds one, to prove the store, its saving and the bindings work end to end.
private struct StoreCheckView: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var model: AppModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Bay").font(.largeTitle.weight(.semibold))
      Text(model.tabs.count == 1 ? strings.t("tabs.one") : strings.t("tabs.count", ["count": "\(model.tabs.count)"]))
        .accessibilityIdentifier("tab-count")
      ForEach(model.tabs, id: \.id) { tab in
        Text(tab.url.isEmpty ? "—" : tab.url)
          .font(.footnote)
          .foregroundStyle(tab.id == model.activeTabId ? .primary : .secondary)
      }
      Button(strings.t("tabs.newTab")) {
        let now = AppModel.now()
        let tab = BrowserTab(
          id: UUID().uuidString, url: "https://example.com/\(model.tabs.count)", title: "", favicon: nil,
          createdAt: now, lastVisit: now, snapshot: nil, private: false, spaceId: model.activeSpaceId, folderId: nil
        )
        model.dispatch(.newTab(tab: tab, background: false))
      }
      .accessibilityIdentifier("new-tab")
      Text("Core \(BayCore.version()) · \(strings.locale)")
        .font(.footnote)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("core-version")
    }
    .padding()
  }
}
