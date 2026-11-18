import BayCore
import BayEngine
import Foundation
import UIKit

/// What a search opens: a page, an open tab, or a tab back from the archive.
enum OpenTarget: Equatable {
  case url(String)
  case tab(String)
  case archived(String)
}

/// The browser screen's state over the store: which pages are loaded, what each reports, and what is over them. The
/// Expo app's BrowserScreen, without its rendering. Every change to tabs goes through the core's store.
@MainActor
final class BrowserModel: ObservableObject {
  enum Overlay: Equatable {
    case none, search, tabs
  }

  /// At most this many pages stay loaded; the rest reload from their saved state when shown again.
  static let maxLive = 4

  let app: AppModel
  @Published var overlay: Overlay = .none
  /// The search was started for a new tab (from the switcher) rather than for the page on screen.
  @Published private(set) var searchInNewTab = false
  @Published private(set) var searchPrivately = false
  /// What each loaded page last reported.
  @Published private(set) var navigation: [String: NavigationState] = [:]
  /// A page that failed to load, while its tab shows.
  @Published private(set) var failure: (tabId: String, url: String, message: String)?
  /// The loaded pages, the one showing first.
  @Published private(set) var mounted: [String] = []
  /// The colour at the top of each page, for the strip behind the status bar ([r, g, b]); nil when it has none.
  @Published private(set) var pageColors: [String: [Double]] = [:]

  private var views: [String: EngineView] = [:]
  /// The address each tab was last counted as a visit for.
  private var visited: [String: String] = [:]
  private var timing: [String: ScriptTiming] = [:]
  private var failed: Set<String> = []

  init(app: AppModel) {
    self.app = app
  }

  // MARK: What shows

  var activeTab: BrowserTab? {
    app.tabs.first { $0.id == app.activeTabId }
  }

  /// The tab showing has a page; otherwise the start page shows.
  var hasPage: Bool {
    !(activeTab?.url.isEmpty ?? true)
  }

  var activeNavigation: NavigationState {
    navigation[app.activeTabId] ?? .empty
  }

  var engine: SearchEngine {
    searchEngine(id: app.preferences.searchEngineId, customUrl: app.preferences.customSearchUrl)
  }

  /// The page view for a tab, made the first time it is shown and kept while it stays loaded.
  func view(for tab: BrowserTab) -> EngineView {
    if let view = views[tab.id] { return view }
    let view = EngineView(isPrivate: tab.private, profile: tab.spaceId)
    // Private tabs keep no saved state.
    view.stateKey = tab.private ? nil : tab.id
    let id = tab.id
    view.onEvent = { [weak self] event in
      // EngineView reports on the main thread.
      MainActor.assumeIsolated { self?.receive(id, event) }
    }
    views[tab.id] = view
    view.loadInitial(tab.url.isEmpty ? nil : tab.url)
    return view
  }

  /// Keeps the tab showing loaded, with the most recently shown others, up to `maxLive`.
  func refreshMounted() {
    let existing = Set(app.tabs.map(\.id))
    var next = hasPage ? [app.activeTabId] : []
    for id in mounted where id != app.activeTabId && existing.contains(id) && next.count < Self.maxLive {
      next.append(id)
    }
    for (id, view) in views where !next.contains(id) {
      view.saveState()
      view.removeFromSuperview()
      views[id] = nil
      navigation[id] = nil
      timing[id] = nil
    }
    if next != mounted { mounted = next }
  }

  // MARK: Actions

  func search(inNewTab: Bool, privately: Bool = false) {
    searchInNewTab = inNewTab
    searchPrivately = privately
    overlay = .search
  }

  func dismissSearch() {
    overlay = .none
  }

  func open(_ target: OpenTarget, privately: Bool) {
    overlay = .none
    switch target {
    case .tab(let id): activate(id)
    case .archived(let id): restore(id)
    case .url(let url):
      // The tab showing takes the page unless the search was for a new tab, or private mode changed.
      let active = activeTab
      if let active, !searchInNewTab || !hasPage, active.private == privately {
        navigate(active.id, url)
        return
      }
      let emptyTab = hasPage ? nil : active?.id
      openTab(url, privately: privately)
      if let emptyTab { close(emptyTab) }
    }
  }

  func navigate(_ tabId: String, _ url: String) {
    app.dispatch(.updateTab(id: tabId, update: TabUpdate(url: url, title: nil, favicon: nil, lastVisit: nil, snapshot: nil)))
    if let view = views[tabId] {
      try? view.load(url)
    }
    refreshMounted()
  }

  func activate(_ id: String) {
    app.dispatch(.activateTab(id: id, now: AppModel.now()))
    overlay = .none
    refreshMounted()
  }

  func openTab(_ url: String, privately: Bool = false, background: Bool = false) {
    let tab = Self.blankTab(spaceId: app.activeSpaceId, url: url, privately: privately)
    app.dispatch(.newTab(tab: tab, background: background))
    refreshMounted()
  }

  /// Closes a tab into the archive (private tabs are simply gone). A space left without tabs gets a blank one.
  func close(_ id: String) {
    let spaceId = app.store.tabs().first { $0.id == id }?.spaceId ?? app.activeSpaceId
    app.dispatch(.closeTab(id: id, now: AppModel.now(), fallback: Self.blankTab(spaceId: spaceId)))
    visited[id] = nil
    refreshMounted()
  }

  // MARK: The tab switcher

  /// The space's tabs the switcher's grid shows: a tab showing a pinned page is reached by its pin instead.
  var switcherTabs: [BrowserTab] {
    let pinned = Set(app.pins.map(\.url))
    return app.tabs.filter { $0.url.isEmpty || !pinned.contains($0.url) }
  }

  func showTabs() {
    if hasPage { capture(app.activeTabId) }
    overlay = .tabs
  }

  /// Takes the tab's picture for the switcher now. Private tabs and failed pages keep none.
  func capture(_ tabId: String) {
    guard let view = views[tabId], !failed.contains(tabId),
          app.tabs.first(where: { $0.id == tabId })?.private == false
    else { return }
    Task { [weak self] in
      guard let uri = try? await view.snapshot() else { return }
      self?.app.dispatch(
        .updateTab(id: tabId, update: TabUpdate(url: nil, title: nil, favicon: nil, lastVisit: nil, snapshot: .some(uri))))
    }
  }

  /// Archives every tab in the switcher's grid; the pinned ones stay.
  func archiveAll() {
    for tab in switcherTabs { close(tab.id) }
    overlay = .none
  }

  /// Switches to a space: the tab it was last on (or a fresh one) becomes current.
  func selectSpace(_ id: String) {
    guard id != app.activeSpaceId else { return }
    let hasTab = app.store.tabs().contains { $0.spaceId == id }
    app.dispatch(.selectSpace(id: id, blankTab: hasTab ? nil : Self.blankTab(spaceId: id)))
    refreshMounted()
  }

  func createSpace(name: String) {
    let space = app.store.newSpace(id: UUID().uuidString, name: name)
    app.dispatch(.createSpace(space: space, blankTab: Self.blankTab(spaceId: space.id)))
    refreshMounted()
  }

  /// A pin's page: its tab in the space when one is open there, else a new one.
  func openPin(_ site: PinnedSite) {
    if let open = app.store.tabs().first(where: { $0.spaceId == site.spaceId && $0.url == site.url }) {
      activate(open.id)
      return
    }
    overlay = .none
    openTab(site.url)
  }

  func restore(_ id: String) {
    app.dispatch(.restoreTab(id: id, restoredId: UUID().uuidString, now: AppModel.now()))
    refreshMounted()
  }

  func retry() {
    guard let failure else { return }
    self.failure = nil
    navigate(failure.tabId, failure.url)
  }

  static func blankTab(spaceId: String, url: String = "", privately: Bool = false) -> BrowserTab {
    let now = AppModel.now()
    return BrowserTab(
      id: UUID().uuidString, url: url, title: "", favicon: nil, createdAt: now, lastVisit: now, snapshot: nil,
      private: privately, spaceId: spaceId, folderId: nil)
  }

  // MARK: Page reports

  private func receive(_ tabId: String, _ event: EngineEvent) {
    switch event {
    case .navigation(let state): navigated(tabId, state)
    case .failure(let error):
      failed.insert(tabId)
      failure = (tabId, error.url.isEmpty ? (navigation[tabId]?.url ?? "") : error.url, error.message)
    case .newWindow(let url, let isPrivate):
      // A new window becomes a real tab in front, in the opener's own session.
      if isWebUrl(value: url) { openTab(url, privately: isPrivate) }
    case .pageRequest(let request):
      // Page dialogs get their sheet with the panels (N5); until then nothing waits on one.
      views[tabId]?.answerPageRequest(id: request.id, accepted: false, value: nil, username: nil, password: nil)
    default:
      break
    }
  }

  private func navigated(_ tabId: String, _ state: NavigationState) {
    let started = state.isLoading && !(navigation[tabId]?.isLoading ?? false)
    let finished = !state.isLoading && (navigation[tabId]?.isLoading ?? true)
    if navigation[tabId] != state { navigation[tabId] = state }
    if started {
      failed.remove(tabId)
      if failure?.tabId == tabId { failure = nil }
    }
    if finished, let view = views[tabId] {
      Task { [weak self] in
        let color = (try? await view.runScript(.pageColor)).flatMap { try? JSONDecoder().decode([Double]?.self, from: Data($0.utf8)) } ?? nil
        self?.pageColors[tabId] = color
      }
    }
    let plan = scriptsFor(
      timing: timing[tabId] ?? initialTiming(),
      state: NavigationReport(url: state.url, progress: state.progress, isLoading: state.isLoading), hasRules: false)
    timing[tabId] = plan.timing
    if plan.watchMedia, let view = views[tabId] {
      Task { _ = try? await view.runScript(.watchMedia) }
    }

    if state.blank {
      app.dispatch(.updateTab(id: tabId, update: TabUpdate(url: "", title: "", favicon: nil, lastVisit: nil, snapshot: nil)))
      return
    }
    guard isWebUrl(value: state.url) else { return }
    if failed.contains(tabId) {
      app.dispatch(.updateTab(id: tabId, update: TabUpdate(url: state.url, title: nil, favicon: nil, lastVisit: nil, snapshot: nil)))
      return
    }
    app.dispatch(
      .updateTab(
        id: tabId,
        update: TabUpdate(
          url: state.url, title: state.title.isEmpty ? nil : state.title, favicon: nil, lastVisit: nil, snapshot: nil)))
    // Private pages stay out of history.
    guard let tab = app.store.tabs().first(where: { $0.id == tabId }), !tab.private else { return }
    if !state.title.isEmpty, visited[tabId] == state.url {
      app.dispatch(.pageTitle(url: state.url, title: state.title))
    }
    if !state.isLoading, visited[tabId] != state.url {
      visited[tabId] = state.url
      app.dispatch(
        .visit(spaceId: tab.spaceId, url: state.url, title: state.title, favicon: nil, now: AppModel.now()))
      // The tab's picture once the page has drawn: a newer visit replaces it.
      Task { [weak self] in
        try? await Task.sleep(nanoseconds: 600_000_000)
        self?.capture(tabId)
      }
    }
  }
}
