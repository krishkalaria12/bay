import BayCore
import SwiftUI

@main
struct BayApp: App {
  @StateObject private var strings: Strings
  @StateObject private var model: AppModel
  @StateObject private var browser: BrowserModel
  @State private var showsChecks = false
  @Environment(\.scenePhase) private var scenePhase

  init() {
    let strings = Strings()
    let model = AppModel(barTitle: strings.t("sync.bar"))
    _strings = StateObject(wrappedValue: strings)
    _model = StateObject(wrappedValue: model)
    _browser = StateObject(wrappedValue: BrowserModel(app: model, strings: strings))
  }

  var body: some Scene {
    WindowGroup {
      BrowserScreen(browser: browser, onSettings: { showsChecks = true })
        // The stand-in screens (sync, the engine check) sit behind Settings until it lands (plan N5).
        .sheet(isPresented: $showsChecks) {
          StoreCheckView()
            .environmentObject(strings)
            .environmentObject(model)
        }
        .environmentObject(strings)
        .environmentObject(model)
    }
    .onChange(of: scenePhase) { phase in
      switch phase {
      case .active:
        model.startSyncing()
      case .background:
        browser.appLeft()
        model.stopSyncing()
        model.dispatch(.left(now: AppModel.now()))
        model.flush()
      default:
        break
      }
    }
  }
}

/// The stand-in screen behind Settings until it lands (plan N5): the space's tabs from the core's store, a button that
/// adds one, sync, the link resolver and the engine check, to prove each works end to end.
private struct StoreCheckView: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var model: AppModel
  @State private var showsEngine = false

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
      Button {
        model.resolve("https://www.github.com")
      } label: {
        Text(verbatim: "Resolve https://www.github.com")
      }
      .accessibilityIdentifier("resolve-link")
      if let resolved = model.resolved {
        Text(verbatim: resolved).font(.footnote).accessibilityIdentifier("resolved-link")
      }
      Button {
        showsEngine = true
      } label: {
        Text(verbatim: "Engine check")
      }
      .accessibilityIdentifier("engine-check")
      Text("Core \(BayCore.version()) · \(strings.locale)")
        .font(.footnote)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("core-version")
    }
    .padding()
    .fullScreenCover(isPresented: $showsEngine) { EngineCheckView().environmentObject(model) }
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
