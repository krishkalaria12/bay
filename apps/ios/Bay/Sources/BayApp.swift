import BayCore
import SwiftUI

@main
struct BayApp: App {
  @StateObject private var strings: Strings
  @StateObject private var model: AppModel
  @Environment(\.scenePhase) private var scenePhase

  init() {
    let strings = Strings()
    _strings = StateObject(wrappedValue: strings)
    _model = StateObject(wrappedValue: AppModel(barTitle: strings.t("sync.bar")))
  }

  var body: some Scene {
    WindowGroup {
      StoreCheckView()
        .environmentObject(strings)
        .environmentObject(model)
    }
    .onChange(of: scenePhase) { phase in
      switch phase {
      case .active:
        model.startSyncing()
      case .background:
        model.stopSyncing()
        model.dispatch(.left(now: AppModel.now()))
        model.flush()
      default:
        break
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
      SyncCheckView()
      Text("Core \(BayCore.version()) · \(strings.locale)")
        .font(.footnote)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("core-version")
    }
    .padding()
  }
}

/// A stand-in for Settings › Sync until it lands (plan N5): the status, the devices, pairing by code and joining by
/// the recovery phrase, to prove sync works end to end against the relay.
private struct SyncCheckView: View {
  @EnvironmentObject private var model: AppModel
  @State private var phrase = ""
  @State private var problem: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Sync: \(String(describing: model.syncView.status))")
        .accessibilityIdentifier("sync-status")
      ForEach(model.syncView.devices, id: \.id) { device in
        Text("\(device.name)\(device.current ? " (this phone)" : "")").font(.footnote)
      }
      if case let .waiting(code, digits) = model.syncView.pairing {
        Text(code).font(.title2.monospaced()).accessibilityIdentifier("sync-code")
        Text(digits).accessibilityIdentifier("sync-digits")
      }
      if model.syncView.status == .off {
        Button("Pair with a computer") { model.pair() }.accessibilityIdentifier("sync-pair")
        TextField("Recovery phrase", text: $phrase).accessibilityIdentifier("sync-phrase")
        Button("Join") {
          Task { problem = await model.join(phrase: phrase) }
        }
        .accessibilityIdentifier("sync-join")
        if let problem { Text(problem).font(.footnote).foregroundStyle(.red) }
      } else {
        Button("Sync now") { model.syncNow() }.accessibilityIdentifier("sync-now")
        Button("Leave") { model.leave() }.accessibilityIdentifier("sync-leave")
      }
    }
  }
}
