import BayCore
import SwiftUI

@main
struct BayApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @StateObject private var strings: Strings
  @StateObject private var model: AppModel
  @StateObject private var browser: BrowserModel
  @StateObject private var settings: SettingsModel
  @State private var showsChecks = false
  /// The first run, while it's on screen.
  @State private var welcome: FirstRun?
  @State private var launched = false
  @Environment(\.scenePhase) private var scenePhase

  init() {
    let strings = Strings()
    let model = AppModel(barTitle: strings.t("sync.bar"))
    _strings = StateObject(wrappedValue: strings)
    _model = StateObject(wrappedValue: model)
    let browser = BrowserModel(app: model, strings: strings)
    _browser = StateObject(wrappedValue: browser)
    _settings = StateObject(wrappedValue: SettingsModel(app: model, browser: browser, strings: strings))
  }

  var body: some Scene {
    WindowGroup {
      ZStack {
        BrowserScreen(browser: browser, onSettings: settings.open, onChecks: { showsChecks = true })
          .accessibilityHidden(settings.visible || welcome != nil)
        if settings.visible {
          SettingsScreen(settings: settings).transition(.move(edge: .bottom))
        }
        if let welcome {
          FirstRunView(run: welcome).zIndex(1)
        }
      }
      .onAppear(perform: launch)
      .onOpenURL { IncomingLinks.shared.arrive($0.absoluteString) }
      // Settings › General › Show welcome again.
      .onChange(of: model.preferences.welcomed) { welcomed in
        if !welcomed { showWelcome() }
      }
      .animation(.easeOut(duration: 0.35), value: settings.visible)
      .onChange(of: settings.visible) { browser.covered = $0 }
        // The stand-in screens (the engine check, the store check) behind a long press on Settings, for testing.
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
        model.refreshBangs()
        if launched { cameBack() }
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

extension BayApp {
  /// Bay opens ready to type (C1): the search card comes up as it starts, over a fresh start page after a long time
  /// away. Not on the run that shows the welcome, which ends on the field itself when it's skipped.
  private func launch() {
    guard !launched else { return }
    launched = true
    let opened = model.store.startFresh(now: AppModel.now(), newTabId: UUID().uuidString)
    guard model.preferences.welcomed else {
      showWelcome()
      return
    }
    if model.preferences.openSearchOnLaunch {
      // Over a page, a new search starts a new tab and leaves the page as it was.
      browser.search(inNewTab: !opened && !(browser.activeTab?.url.isEmpty ?? true))
    }
    takeLinks()
  }

  /// The browser takes links from other apps from now on, starting with one that waited for it. Settings goes first.
  private func takeLinks() {
    IncomingLinks.shared.receiver = { [browser, settings] url in
      if browser.openIncoming(url) { settings.close() }
    }
  }

  /// Back in front: a fresh start page after a long time away, ready to type too.
  private func cameBack() {
    guard welcome == nil, model.store.startFresh(now: AppModel.now(), newTabId: UUID().uuidString) else { return }
    browser.overlay = .none
    browser.panel = nil
    settings.close()
    if model.preferences.openSearchOnLaunch { browser.search(inNewTab: false) }
  }

  private func showWelcome() {
    guard welcome == nil else { return }
    settings.close()
    // Links wait under the welcome, and open once it's done.
    IncomingLinks.shared.receiver = nil
    welcome = FirstRun(strings: strings) { [model, browser] openField in
      model.dispatch(.preferences(update: .welcomedNow))
      welcome = nil
      // Skipped early: the glass hands over to the real field.
      if openField { browser.search(inNewTab: false) }
      takeLinks()
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
