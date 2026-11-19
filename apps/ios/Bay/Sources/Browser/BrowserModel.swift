import BayCore
import BayDesign
import BayEngine
import Combine
import Foundation
import LocalAuthentication
import UIKit

/// What a search opens: a page, an open tab, or a tab back from the archive.
enum OpenTarget: Equatable {
  case url(String)
  case tab(String)
  case archived(String)
}

/// One short message above the bar; a newer one replaces it. One with an action (Undo) stays longer.
struct ToastMessage: Identifiable {
  let id = UUID()
  let text: String
  let actionLabel: String?
  let action: (() -> Void)?
  /// A reading tool's notice (Inspect, Reader, the element picker), which has its own id.
  var notice = false
}

/// What a tab's media last reported, and when.
struct TabMedia {
  var report: MediaReport
  var at: Date
}

/// The browser screen's state over the store: which pages are loaded, what each reports, and what is over them. The
/// Expo app's BrowserScreen, without its rendering. Every change to tabs goes through the core's store.
@MainActor
final class BrowserModel: ObservableObject {
  enum Overlay: Equatable {
    case none, search, tabs
  }

  /// The sheet open over the browser.
  enum Panel: Equatable {
    case page, spaceEdit, archive, history, bookmarks, downloads, siteSettings, link, tabs, pin, request, reader, inspect, `import`
  }

  /// Ad and tracker blocking on the page showing: on, paused for its site, off for this visit only, or off in Settings.
  enum PageBlocking: Equatable {
    case on, paused, restored, off
  }

  /// Find on page: the words, and what the page found for them.
  struct FindState: Equatable {
    var query = ""
    /// Matches for `foundFor`, or nil before the first search finishes.
    var count: Int?
    /// The current match, from 0.
    var index = -1
    var foundFor = ""
  }

  /// At most this many pages stay loaded; the rest reload from their saved state when shown again.
  static let maxLive = 4

  let app: AppModel
  let strings: Strings
  @Published var overlay: Overlay = .none
  @Published var panel: Panel? {
    didSet {
      // The prompts sheet swiped away (or covered by another): the page's question is cancelled.
      if oldValue == .request, panel != .request, !pageRequests.isEmpty { answerPageRequest(accepted: false) }
      // Inspect's details closed: the picker stays on, ready for the next tap.
      if oldValue == .inspect, panel != .inspect { inspected = nil }
    }
  }
  /// What pages asked and wait on, oldest first; the prompts sheet shows the first.
  @Published private(set) var pageRequests: [(tabId: String, request: PageRequest)] = []
  /// A screen of its own (Settings) is over the browser: no page is active, and VoiceOver skips them.
  @Published var covered = false
  /// A card growing into its page: the tab and where its card sat on screen.
  @Published private(set) var zoom: (tab: BrowserTab, frame: CGRect)?
  @Published private(set) var toast: ToastMessage?
  /// The bar is scrolled away while the page scrolls down.
  @Published private(set) var barHidden = false
  /// Media playing (or paused) in each tab, as its page reports it.
  @Published private(set) var media: [String: TabMedia] = [:]
  /// Private tabs are covered once Bay has been in the background, until the owner unlocks them.
  @Published private(set) var locked = false
  /// The search was started for a new tab (from the switcher) rather than for the page on screen.
  @Published private(set) var searchInNewTab = false
  @Published private(set) var searchPrivately = false
  /// The search card starts listening as it opens: the widget's microphone (C7).
  @Published private(set) var searchListening = false
  /// What each loaded page last reported.
  @Published private(set) var navigation: [String: NavigationState] = [:]
  /// A page that failed to load, while its tab shows.
  @Published private(set) var failure: (tabId: String, url: String, message: String)?
  /// The loaded pages, the one showing first.
  @Published private(set) var mounted: [String] = []
  /// The colour at the top of each page, for the strip behind the status bar ([r, g, b]); nil when it has none.
  @Published private(set) var pageColors: [String: [Double]] = [:]
  /// Find on page, while it is open over the page showing.
  @Published private(set) var find: FindState?
  /// What the blocker stopped on each page, where the engine counts it.
  @Published private(set) var blocked: [String: Int] = [:]
  /// A site shown without blocking until its tab leaves it.
  @Published private(set) var restoredHost: String?
  /// What the element picker does with a tap on the page: hide the element, or describe it.
  enum PickMode { case hide, inspect }
  /// The element picker on the page showing, while it runs.
  @Published private(set) var picking: PickMode?
  /// What the picker selected last.
  @Published private(set) var picked: PickedElement?
  /// What Inspect read about the picked element.
  @Published private(set) var inspected: InspectedElement?
  /// Private tabs' hidden elements, by tab and host: kept in memory only, and gone with the tab.
  private var privateRules: [String: [String: [String]]] = [:]
  private var youtubeWatch: AnyCancellable?
  /// The download the toast above the bar shows: the latest one, until six seconds after it settles.
  @Published private(set) var downloadToastId: String?
  private var downloadToastTimer: Task<Void, Never>?
  /// The tab whose page Reader is showing; a new page in it, or another tab, ends Reader.
  @Published private(set) var readerTab: String?
  /// The address Reader last opened by itself on (a site that keeps Reader on), so coming back stays quiet.
  private var autoReaderUrl: String?
  /// The tab whose card was held, for the pin sheet.
  @Published private(set) var pinTab: BrowserTab?
  /// The folder picked in the tabs menu, which it renames or deletes.
  @Published var activeFolderId: String?
  /// The link (or bare image) a long press on the page showing opened the link menu for.
  @Published private(set) var link: LinkPress?

  private var views: [String: EngineView] = [:]
  /// The address each tab was last counted as a visit for.
  private var visited: [String: String] = [:]
  private var timing: [String: ScriptTiming] = [:]
  private var failed: Set<String> = []
  /// AMP pages each tab already left for their publisher's page. One that comes back stays, so the two never bounce.
  private var ampLeft: [String: Set<String>] = [:]
  private var findTimer: Task<Void, Never>?

  private var toastTimer: Task<Void, Never>?
  /// Tabs stopped from the mini player or the system's controls: the pause report that follows stays out.
  private var stopped: Set<String> = []

  init(app: AppModel, strings: Strings) {
    self.app = app
    self.strings = strings
    app.mediaControl = { [weak self] control in self?.mediaControl(control) }
    app.downloadUpdated = { [weak self] update in self?.downloadUpdated(update) }
    // Published before it changes: the pages hear it once the new value is in.
    youtubeWatch = app.$preferences.map(\.youtube).removeDuplicates().dropFirst().receive(on: RunLoop.main)
      .sink { [weak self] _ in self?.applyHiddenToOpenPages() }
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
    configure(view, url: tab.url)
    view.loadInitial(tab.url.isEmpty ? nil : tab.url)
    return view
  }

  /// Keeps the tab showing loaded, with the most recently shown others, up to `maxLive`.
  func refreshMounted() {
    let existing = Set(app.tabs.map(\.id))
    var next = hasPage ? [app.activeTabId] : []
    // A tab playing media stays loaded, so its sound doesn't stop when others open.
    let playing = media.filter { $0.value.report.playing }.map(\.key).filter { existing.contains($0) }
    for id in playing + mounted where !next.contains(id) && existing.contains(id) && next.count < Self.maxLive {
      next.append(id)
    }
    for (id, view) in views where !next.contains(id) {
      view.saveState()
      view.removeFromSuperview()
      views[id] = nil
      navigation[id] = nil
      timing[id] = nil
      // An unloaded page no longer waits on its questions.
      if pageRequests.contains(where: { $0.tabId == id }) {
        pageRequests.removeAll { $0.tabId == id }
        if pageRequests.isEmpty, panel == .request { panel = nil }
      }
      if media[id] != nil {
        media[id] = nil
        updateMediaSession()
      }
    }
    if next != mounted { mounted = next }
  }

  /// Takes every page view off the screen and forgets what they reported, for clearing browsing data.
  func closeAllPages() {
    overlay = .none
    panel = nil
    for (_, view) in views { view.removeFromSuperview() }
    views = [:]
    navigation = [:]
    timing = [:]
    visited = [:]
    media = [:]
    pageColors = [:]
    failure = nil
    mounted = []
    Engine.setMediaSession(title: nil, site: "", playing: false)
  }

  // MARK: Actions

  func search(inNewTab: Bool, privately: Bool = false, listening: Bool = false) {
    // A fresh picture of the page, for the card it shrinks into above the search sheet.
    if !inNewTab, hasPage { capture(app.activeTabId) }
    searchInNewTab = inNewTab
    searchPrivately = privately
    searchListening = listening
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
    if id != app.activeTabId {
      endFind()
      readerTab = nil
      pickerGone()
    }
    app.dispatch(.activateTab(id: id, now: AppModel.now()))
    overlay = .none
    barHidden = false
    refreshMounted()
  }

  func openTab(_ url: String, privately: Bool = false, background: Bool = false) {
    let tab = Self.blankTab(spaceId: app.activeSpaceId, url: url, privately: privately)
    app.dispatch(.newTab(tab: tab, background: background))
    refreshMounted()
  }

  /// Closes a tab into the archive (private tabs are simply gone). A space left without tabs gets a blank one.
  func close(_ id: String) {
    let spaceId = app.allTabs.first { $0.id == id }?.spaceId ?? app.activeSpaceId
    app.dispatch(.closeTab(id: id, now: AppModel.now(), fallback: Self.blankTab(spaceId: spaceId)))
    visited[id] = nil
    refreshMounted()
  }

  /// Closes a tab into the archive, with a toast to bring it straight back.
  func archive(_ id: String) {
    let tab = app.allTabs.first { $0.id == id }
    close(id)
    guard let tab, !tab.url.isEmpty, !tab.private else { return }
    showToast(strings.t("toast.tabArchived"), actionLabel: strings.t("toast.undo")) { [weak self] in self?.restore(id) }
  }

  /// Takes a pin away, with a toast to put it back where it was.
  func unpin(_ site: PinnedSite) {
    let index = app.store.pinnedSites(spaceId: site.spaceId).firstIndex { $0.id == site.id } ?? 0
    app.dispatch(.removePin(id: site.id))
    showToast(strings.t("toast.unpinned"), actionLabel: strings.t("toast.undo")) { [weak self] in
      self?.app.dispatch(.addPin(site: site, index: Int64(index)))
    }
  }

  func showToast(_ text: String, actionLabel: String? = nil, action: (() -> Void)? = nil) {
    show(ToastMessage(text: text, actionLabel: actionLabel, action: action))
  }

  /// A reading tool's notice: what Inspect, Reader or the element picker did, or why it couldn't.
  func showNotice(_ text: String) {
    show(ToastMessage(text: text, actionLabel: nil, action: nil, notice: true))
  }

  private func show(_ message: ToastMessage) {
    toast = message
    UIAccessibility.post(notification: .announcement, argument: message.actionLabel.map { "\(message.text). \($0)" } ?? message.text)
    toastTimer?.cancel()
    toastTimer = Task { [weak self] in
      try? await Task.sleep(nanoseconds: message.notice ? 4_000_000_000 : message.action == nil ? 2_500_000_000 : 8_000_000_000)
      guard !Task.isCancelled, self?.toast?.id == message.id else { return }
      self?.toast = nil
    }
  }

  func dismissToast() {
    toast = nil
  }

  // MARK: The bar

  /// Moves to the tab before (-1) or after (1) the one showing, in the switcher's order.
  func swipeTabs(_ step: Int) {
    guard let index = app.tabs.firstIndex(where: { $0.id == app.activeTabId }), app.tabs.indices.contains(index + step) else { return }
    app.dispatch(.tipSeen(id: .bar))
    capture(app.activeTabId)
    activate(app.tabs[index + step].id)
  }

  private func scrolled(_ tabId: String, offsetY: Double, deltaY: Double) {
    guard tabId == app.activeTabId else { return }
    if offsetY < 24 || deltaY < -8 {
      if barHidden { barHidden = false }
    } else if deltaY > 8, !barHidden {
      barHidden = true
    }
  }

  // MARK: Media

  /// The tab whose media the mini player shows: the latest playing one that isn't on screen.
  var player: (tab: BrowserTab, media: TabMedia)? {
    let onScreen = overlay == .none && hasPage ? app.activeTabId : nil
    return latestMedia { $0.id != onScreen && !(locked && $0.private) }
  }

  private func latestMedia(where include: (BrowserTab) -> Bool) -> (tab: BrowserTab, media: TabMedia)? {
    let tabs = app.allTabs
    return media.compactMap { id, state -> (BrowserTab, TabMedia)? in
      guard let tab = tabs.first(where: { $0.id == id }), include(tab) else { return nil }
      return (tab, state)
    }
    .max { a, b in a.1.report.playing == b.1.report.playing ? a.1.at < b.1.at : !a.1.report.playing }
  }

  /// The lock screen and Control Center show the latest media outside private tabs.
  private func updateMediaSession() {
    if let session = latestMedia(where: { !$0.private }) {
      let title = session.media.report.title.isEmpty ? session.tab.title : session.media.report.title
      Engine.setMediaSession(title: title, site: hostOf(url: session.tab.url), playing: session.media.report.playing)
    } else {
      Engine.setMediaSession(title: nil, site: "", playing: false)
    }
  }

  private func mediaControl(_ control: MediaControl) {
    guard let session = latestMedia(where: { !$0.private }) else { return }
    switch control {
    case .toggle: toggleMedia(session.tab.id)
    case .stop: stopMedia(session.tab.id)
    case .skipForward: seekMedia(session.tab.id, by: 10)
    case .skipBackward: seekMedia(session.tab.id, by: -10)
    }
  }

  func toggleMedia(_ tabId: String) {
    command(tabId, .toggleMedia)
  }

  func seekMedia(_ tabId: String, by seconds: Int) {
    command(tabId, .seekMedia, args: ["seconds": seconds])
  }

  func stopMedia(_ tabId: String) {
    stopped.insert(tabId)
    command(tabId, .pauseMedia)
    media[tabId] = nil
    updateMediaSession()
  }

  func pictureInPicture(_ tabId: String) {
    command(tabId, .pipMedia)
  }

  /// Runs a media script on a tab's page; one that finds no media there forgets the tab's media.
  private func command(_ tabId: String, _ script: PageScript, args: [String: Any]? = nil) {
    guard let view = views[tabId] else { return }
    Task { [weak self] in
      let result = try? await view.runScript(script, args: args)
      if result == "null" {
        self?.media[tabId] = nil
        self?.updateMediaSession()
      }
    }
  }

  private func mediaReported(_ tabId: String, _ report: MediaReport) {
    if !report.playing, stopped.contains(tabId) { return }
    stopped.remove(tabId)
    media[tabId] = TabMedia(report: report, at: Date())
    updateMediaSession()
  }

  /// A card picked in the switcher grows into its page; a tab without a picture has nothing to grow from.
  func pick(_ tab: BrowserTab, frame: CGRect) {
    guard tab.snapshot != nil, !UIAccessibility.isReduceMotionEnabled else {
      activate(tab.id)
      return
    }
    zoom = (tab, frame)
  }

  func zoomFinished() {
    guard let zoom else { return }
    self.zoom = nil
    activate(zoom.tab.id)
  }

  // MARK: Tips

  /// The first-run tip showing, if any, one at a time and never while anything else is up: what blocking did, over the
  /// first page that finishes loading with it on, then the bar's swipe once two pages are open. It goes after a while
  /// unanswered.
  var tip: TipId? {
    guard overlay == .none, panel == nil, !locked, !covered, link == nil, find == nil else { return nil }
    let seen = app.preferences.tipsSeen
    if !seen.contains(.blocking), hasPage, !activeNavigation.isLoading, blocking == .on, case .ready = app.blockerStatus {
      return .blocking
    }
    guard !seen.contains(.bar) else { return nil }
    return app.tabs.filter { !$0.url.isEmpty && !$0.private }.count > 1 ? .bar : nil
  }

  private var tipTimer: Task<Void, Never>?

  /// Starts the unanswered tip's clock when one shows.
  func tipShown(_ tip: TipId?) {
    tipTimer?.cancel()
    guard let tip else { return }
    tipTimer = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 12_000_000_000)
      guard !Task.isCancelled else { return }
      self?.app.dispatch(.tipSeen(id: tip))
    }
  }

  // MARK: Spaces

  var activeSpace: BrowserSpace? {
    app.spaces.first { $0.id == app.activeSpaceId }
  }

  func renameSpace(_ id: String, _ name: String) {
    app.dispatch(.renameSpace(id: id, name: name))
  }

  func setSpaceIcon(_ id: String, _ icon: String) {
    app.dispatch(.setSpaceIcon(id: id, icon: icon))
  }

  func setSpaceColor(_ id: String, _ color: SpaceColor) {
    app.dispatch(.setSpaceColor(id: id, color: color))
  }

  /// Moves a space one place along the bar.
  func moveSpace(_ id: String, by step: Int) {
    guard let index = app.spaces.firstIndex(where: { $0.id == id }) else { return }
    app.dispatch(.reorderSpace(id: id, to: Int64(index + step)))
  }

  /// Deletes a space with what it kept, and a moment later its website data.
  func deleteSpace(_ id: String) {
    panel = nil
    app.dispatch(.deleteSpace(id: id, blankTab: Self.blankTab(spaceId: app.store.spaces().first { $0.id != id }?.id ?? "personal")))
    refreshMounted()
    Task {
      try? await Task.sleep(nanoseconds: 1_000_000_000)
      await Engine.deleteProfile(id)
    }
  }

  // MARK: Private tabs

  /// Bay left the foreground: private tabs lock, when the owner asked for that and there are any.
  func appLeft() {
    if app.preferences.lockPrivateTabs, app.allTabs.contains(where: \.private) { locked = true }
  }

  /// Face ID, Touch ID or the passcode unlocks the private tabs.
  func unlock() {
    let context = LAContext()
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: strings.t("lock.prompt")) { success, _ in
      Task { @MainActor [weak self] in
        if success { self?.locked = false }
      }
    }
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

  /// Archives every tab in the switcher's grid; the pinned ones stay. A toast brings them back.
  func archiveAll() {
    let tabs = switcherTabs
    let archived = tabs.filter { !$0.url.isEmpty && !$0.private }.map(\.id)
    for tab in tabs { close(tab.id) }
    overlay = .none
    guard !archived.isEmpty else { return }
    let text = archived.count == 1 ? strings.t("toast.oneTabArchived") : strings.t("toast.tabsArchived", ["count": "\(archived.count)"])
    showToast(text, actionLabel: strings.t("toast.undo")) { [weak self] in
      guard let self else { return }
      for id in archived { self.restore(id) }
      // Closing every tab left a blank one behind.
      for tab in self.app.allTabs where tab.url.isEmpty && tab.spaceId == self.app.activeSpaceId { self.close(tab.id) }
    }
  }

  /// Switches to a space: the tab it was last on (or a fresh one) becomes current.
  func selectSpace(_ id: String) {
    guard id != app.activeSpaceId else { return }
    let hasTab = app.allTabs.contains { $0.spaceId == id }
    app.dispatch(.selectSpace(id: id, blankTab: hasTab ? nil : Self.blankTab(spaceId: id)))
    refreshMounted()
  }

  func createSpace(name: String) {
    let space = app.store.newSpace(id: UUID().uuidString, name: name)
    app.dispatch(.createSpace(space: space, blankTab: Self.blankTab(spaceId: space.id)))
    refreshMounted()
  }

  /// A space with the next default name ("Space 3").
  func newSpace() {
    createSpace(name: strings.t("space.default", ["index": "\(app.spaces.count + 1)"]))
  }

  func newFolder(_ name: String) {
    let folder = BrowserFolder(id: UUID().uuidString, spaceId: app.activeSpaceId, name: name)
    app.dispatch(.newFolder(folder: folder))
    activeFolderId = folder.id
  }

  func renameFolder(_ id: String, _ name: String) {
    app.dispatch(.renameFolder(id: id, name: name))
  }

  /// Deletes a folder; its pinned rows return to the top level.
  func deleteFolder(_ id: String) {
    if activeFolderId == id { activeFolderId = nil }
    app.dispatch(.deleteFolder(id: id))
  }

  /// Moves the tab showing to a space, or into one of the space's folders, where its page is pinned as a row (as the
  /// desktop's Pinned folders hold pinned rows).
  func moveActiveTab(spaceId: String, folderId: String?) {
    let id = app.activeTabId
    app.dispatch(.moveTab(id: id, spaceId: spaceId, folderId: nil))
    activeFolderId = folderId
    if let folderId { app.dispatch(.pinSite(tabId: id, pinId: UUID().uuidString, kind: .row, folderId: folderId)) }
    refreshMounted()
  }

  /// The pin sheet for a held tab card. Private and blank tabs have nothing to pin.
  func showPinMenu(_ tab: BrowserTab) {
    guard !tab.private, !tab.url.isEmpty else { return }
    Haptics.tick()
    pinTab = tab
    panel = .pin
  }

  /// Pins a tab's page that way, or unpins it when it is already pinned so.
  func pin(_ tab: BrowserTab, kind: PinKind, folderId: String?) {
    panel = nil
    app.dispatch(.pinSite(tabId: tab.id, pinId: UUID().uuidString, kind: kind, folderId: folderId))
  }

  /// A pin's page: its tab in the space when one is open there, else a new one.
  func openPin(_ site: PinnedSite) {
    if let open = app.allTabs.first(where: { $0.spaceId == site.spaceId && $0.url == site.url }) {
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

  private func showLinkMenu(_ press: LinkPress) {
    Haptics.tick()
    link = press
    panel = .link
  }

  /// Shares a page address (a link's, an image's) through the system's share sheet.
  func share(_ address: String) {
    guard let url = URL(string: cleanUrl(url: address)) else { return }
    present(UIActivityViewController(activityItems: [url], applicationActivities: nil))
  }

  func copy(_ address: String) {
    UIPasteboard.general.string = cleanUrl(url: address)
    showToast(strings.t("toast.linkCopied"))
  }

  /// Saves a web image to the photo library.
  func saveImage(_ address: String) {
    Task {
      do {
        try await Engine.saveImage(address)
        showToast(strings.t("toast.savedToPhotos"))
      } catch {
        showToast(strings.t("toast.imageNotSaved"))
      }
    }
  }

  /// Answers the page question on show, then shows the next one waiting, if any. `save` files the sign-in typed into
  /// the server's HTTP sign-in, never from a private tab.
  func answerPageRequest(accepted: Bool, value: String? = nil, username: String? = nil, password: String? = nil, save: Bool = false) {
    guard !pageRequests.isEmpty else { return }
    let current = pageRequests.removeFirst()
    views[current.tabId]?.answerPageRequest(id: current.request.id, accepted: accepted, value: value, username: username, password: password)
    if save, accepted, current.request.kind == .auth, let username, let password, !isPrivate(current.tabId) {
      _ = app.logins.save(url: current.request.url, username: username, password: password, now: AppModel.now())
    }
    panel = pageRequests.isEmpty ? (panel == .request ? nil : panel) : .request
  }

  /// Tabs and sites answered from a saved login whose server hasn't accepted it yet: asking again right after means the
  /// saved password is wrong, so that time the sheet asks.
  private var signedInSilently: Set<String> = []

  /// Answers a sign-in with the login saved for its site; false when there's none, it just failed, or the tab is private
  /// (its sign-ins stay in the private session).
  private func signInSilently(_ tabId: String, _ request: PageRequest) -> Bool {
    let key = "\(tabId) \(loginOrigin(request.url))"
    if signedInSilently.remove(key) != nil { return false }
    guard !isPrivate(tabId), let login = app.logins.find(url: request.url), let view = views[tabId] else { return false }
    signedInSilently.insert(key)
    view.answerPageRequest(id: request.id, accepted: true, value: nil, username: login.username, password: login.password)
    return true
  }

  private func loginOrigin(_ url: String) -> String {
    originOf(value: url) ?? url
  }

  /// The icon the page names, for its site; the core keeps it when the site has none yet, or only a small one.
  private func fetchIcon(_ view: EngineView, pageUrl: String) {
    struct Named: Decodable {
      let href: String
      let userAgent: String
    }
    Task { [app] in
      let named = (try? await view.runScript(.favicon)).flatMap { try? JSONDecoder().decode(Named?.self, from: Data($0.utf8)) } ?? nil
      guard let named else { return }
      await app.iconFetcher.pageLoaded(pageUrl: pageUrl, href: named.href, userAgent: named.userAgent)
    }
  }

  private func isPrivate(_ tabId: String) -> Bool {
    app.tabs.first { $0.id == tabId }?.private ?? false
  }

  /// Opens a page from history or bookmarks: a page on screen stays, and the listed one opens beside it.
  func openListed(_ url: String) {
    panel = nil
    overlay = .none
    if hasPage || activeTab == nil {
      openTab(url)
    } else if let tab = activeTab {
      navigate(tab.id, url)
    }
  }

  /// Answers a link from another app (B9, B14, B15). A `bay://` command opens a fresh tab, a private tab, or the search
  /// card over the tab showing; a page takes the tab showing when it's blank, and a new tab otherwise. What is open
  /// over the browser goes first. False for anything else, which is left alone.
  @discardableResult
  func openIncoming(_ value: String) -> Bool {
    if let command = bayCommand(value: value) {
      panel = nil
      link = nil
      switch command {
      case .search: search(inNewTab: false)
      case .voice: search(inNewTab: false, listening: true)
      case .newTab, .privateTab:
        overlay = .none
        openTab("", privately: command == .privateTab)
      }
      return true
    }
    guard let url = incomingLink(value: value) else { return false }
    overlay = .none
    panel = nil
    link = nil
    if let tab = activeTab, tab.url.isEmpty {
      navigate(tab.id, url)
    } else {
      openTab(url)
    }
    return true
  }

  /// Brings an archived tab back and shows it.
  func restoreArchived(_ id: String) {
    panel = nil
    overlay = .none
    restore(id)
  }

  /// The download toast's item, while it has one.
  var downloadToast: DownloadItem? { downloadToastId.flatMap { id in app.downloads.first { $0.id == id } } }

  /// Shows the toast for a download's update; a Wallet pass or a calendar invitation opens itself once saved.
  func downloadUpdated(_ update: DownloadEvent) {
    downloadToastId = update.id
    downloadToastTimer?.cancel()
    if update.state == .finished, opensWhenFinished(filename: update.filename), let item = app.downloads.first(where: { $0.id == update.id }) {
      openDownload(item)
    }
    guard update.state != .started, update.state != .progress else { return }
    downloadToastTimer = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 6_000_000_000)
      guard !Task.isCancelled else { return }
      self?.downloadToastId = nil
    }
  }

  // MARK: Import

  /// Opens pasted links as background tabs, or files them in the archive, and says how many came in.
  func importLinks(_ tabs: [ImportedTab], archive: Bool) {
    let count = Int(app.store.importTabs(tabs: tabs, archive: archive, now: AppModel.now()))
    panel = nil
    guard count > 0 else {
      showToast(strings.t("toast.linksAlreadyHere"))
      return
    }
    let key = archive ? (count == 1 ? "toast.archivedTab" : "toast.archivedTabs") : (count == 1 ? "toast.openedTab" : "toast.openedTabs")
    showToast(strings.t(key, ["count": "\(count)"]))
  }

  /// Adds the chosen parts of an export to the space showing; its bookmarks go in a folder named for the browser.
  func importExport(_ chosen: ChosenExport, choice: ImportChoice, folderName: String) -> ImportCounts {
    app.store.importExport(contents: chosen.contents, choice: choice, folderName: folderName, now: AppModel.now())
  }

  /// Opens a finished download in the phone's viewer for its kind.
  func openDownload(_ item: DownloadItem) {
    guard item.state == .finished, let path = item.path else { return }
    do {
      try Engine.openDownload(path)
    } catch {
      showToast(strings.t("downloads.status.failed"))
    }
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
    case .pageMessage(let message):
      if let report = parseMediaMessage(message: message) {
        mediaReported(tabId, report)
      } else if tabId == app.activeTabId, picking != nil, let element = parsePickedMessage(message: message) {
        picked = element
        if picking == .inspect { inspectPicked() }
      } else if tabId == app.activeTabId, let press = parseImagePress(message: message) {
        showLinkMenu(LinkPress(url: press.url, title: press.title, x: nil, y: nil, image: true))
      }
    case .linkPress(let press):
      if tabId == app.activeTabId { showLinkMenu(press) }
    case .blockedCount(let count):
      blocked[tabId] = count
    case .scroll(let offsetY, let deltaY):
      scrolled(tabId, offsetY: offsetY, deltaY: deltaY)
    case .pageRequest(let request):
      if request.kind == .auth, signInSilently(tabId, request) { break }
      pageRequests.append((tabId, request))
      panel = .request
    default:
      break
    }
  }

  private func navigated(_ tabId: String, _ state: NavigationState) {
    let started = state.isLoading && !(navigation[tabId]?.isLoading ?? false)
    let finished = !state.isLoading && (navigation[tabId]?.isLoading ?? true)
    let moved = navigation[tabId]?.url != state.url
    if navigation[tabId] != state { navigation[tabId] = state }
    if moved, let view = views[tabId] { configure(view, url: state.url) }
    if tabId == app.activeTabId, let restoredHost, hostOf(url: state.url) != restoredHost {
      // A site shown without blocking for one visit gets its blocking back once the tab is somewhere else.
      self.restoredHost = nil
      applyBlockingPauses()
    }
    if started {
      blocked[tabId] = nil
      if tabId == app.activeTabId { endFind() }
      if readerTab == tabId { readerTab = nil }
      if tabId == app.activeTabId { pickerGone() }
      failed.remove(tabId)
      if failure?.tabId == tabId { failure = nil }
      // A new document has no media until it reports some.
      if media[tabId] != nil {
        media[tabId] = nil
        updateMediaSession()
      }
    }
    if finished, tabId == app.activeTabId { openReaderBySite(tabId, url: state.url) }
    if finished, let view = views[tabId] {
      Task { [weak self] in
        let color = (try? await view.runScript(.pageColor)).flatMap { try? JSONDecoder().decode([Double]?.self, from: Data($0.utf8)) } ?? nil
        self?.pageColors[tabId] = color
      }
      // The site's icon, unless the tab is private: its icon would say what was opened privately.
      if !isPrivate(tabId) { fetchIcon(view, pageUrl: state.url) }
    }
    let rules = app.allTabs.first { $0.id == tabId }.map { pageHidden($0, url: state.url) } ?? []
    let plan = scriptsFor(
      timing: timing[tabId] ?? initialTiming(),
      state: NavigationReport(url: state.url, progress: state.progress, isLoading: state.isLoading), hasRules: !rules.isEmpty)
    timing[tabId] = plan.timing
    if plan.hideElements, let view = views[tabId] { hide(rules, in: view) }
    if plan.watchMedia, let view = views[tabId] {
      // Early in each load (so text doesn't jump late) and again once it finishes.
      applyTweaks(tabId, url: state.url)
      Task {
        _ = try? await view.runScript(.watchMedia)
        // WebKit's menu hook knows links but not bare images, so the page reports their long presses itself.
        _ = try? await view.runScript(.watchImages)
      }
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
    guard let tab = app.allTabs.first(where: { $0.id == tabId }), !tab.private else { return }
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

// MARK: - The page menu

extension BrowserModel {
  private var activeView: EngineView? { views[app.activeTabId] }

  /// The address the page showing is at: what it last reported, else its tab's.
  var activeUrl: String {
    let reported = activeNavigation.url
    return reported.isEmpty ? (activeTab?.url ?? "") : reported
  }

  func goBack() { activeView?.goBack() }
  func goForward() { activeView?.goForward() }
  func reload() { activeView?.reload() }
  func stop() { activeView?.stop() }

  var isPinned: Bool {
    let url = activeTab?.url
    return app.pins.contains { $0.kind == .essential && $0.url == url }
  }

  var isBookmarked: Bool {
    guard let url = activeTab?.url, !url.isEmpty else { return false }
    return app.store.isBookmarked(spaceId: app.activeSpaceId, url: url)
  }

  func togglePin() {
    guard let tab = activeTab else { return }
    Haptics.tick()
    let pinned = isPinned
    app.dispatch(.pinSite(tabId: tab.id, pinId: UUID().uuidString, kind: .essential, folderId: nil))
    showToast(pinned ? strings.t("toast.unpinned") : strings.t("toast.pinned"))
  }

  func toggleBookmark() {
    guard let tab = activeTab, !tab.url.isEmpty else { return }
    Haptics.tick()
    let bookmarked = isBookmarked
    app.dispatch(
      .toggleBookmark(
        spaceId: app.activeSpaceId,
        bookmark: .url(id: UUID().uuidString, parentId: "bookmarks", title: tab.title.isEmpty ? tab.url : tab.title, url: tab.url, addedAt: AppModel.now())))
    if bookmarked {
      showToast(strings.t("toast.unbookmarked"))
    } else {
      showToast(strings.t("toast.bookmarked"), actionLabel: strings.t("toast.showBookmarks")) { [weak self] in self?.panel = .bookmarks }
    }
  }

  func share() {
    share(activeUrl)
  }

  func copyLink() {
    copy(activeUrl)
  }

  /// The page through Google Translate, into the app's language.
  func translate() {
    let url = activeUrl
    guard !url.isEmpty else { return }
    if url.range(of: #"^https://[^/]+\.translate\.goog/"#, options: .regularExpression) != nil { return }
    let language = strings.locale.split(separator: "-").first.map(String.init) ?? "en"
    let encoded = url.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? url
    navigate(app.activeTabId, "https://translate.google.com/translate?sl=auto&tl=\(language)&u=\(encoded)")
  }

  /// The article on the page as Markdown, on the clipboard.
  // MARK: Hide elements and Inspect

  /// The elements hidden on a tab's site: its own list in a private tab, else the site's saved one.
  func hiddenSelectors(_ tab: BrowserTab, url: String? = nil) -> [String] {
    let address = url ?? tab.url
    if tab.private { return privateRules[tab.id]?[hostOf(url: address)] ?? [] }
    return app.store.hiddenSelectors(url: address)
  }

  /// Everything a page hides: its site's hidden elements, and on YouTube what Settings > YouTube cleans up.
  private func pageHidden(_ tab: BrowserTab, url: String) -> [String] {
    hiddenSelectors(tab, url: url) + youtubeSelectors(cleanup: app.preferences.youtube, url: url)
  }

  /// A change to Settings > YouTube reaches the YouTube pages already open.
  private func applyHiddenToOpenPages() {
    for (tabId, view) in views {
      guard let tab = app.allTabs.first(where: { $0.id == tabId }) else { continue }
      let reported = navigation[tabId]?.url ?? ""
      hide(pageHidden(tab, url: reported.isEmpty ? tab.url : reported), in: view)
    }
  }

  /// The elements hidden on the page showing.
  var activeHidden: [String] { activeTab.map { hiddenSelectors($0, url: activeUrl) } ?? [] }

  private func hide(_ selectors: [String], in view: EngineView) {
    Task { _ = try? await view.runScript(.hideElements, args: ["selectors": selectors]) }
  }

  /// Keeps the site's hidden elements and applies them to the page showing at once.
  private func setHidden(_ selectors: [String]) {
    guard let tab = activeTab else { return }
    let host = hostOf(url: activeUrl)
    if tab.private {
      privateRules[tab.id, default: [:]][host] = selectors
    } else {
      app.dispatch(.hiddenElements(host: host, selectors: selectors))
    }
    if let view = activeView { hide(selectors + youtubeSelectors(cleanup: app.preferences.youtube, url: activeUrl), in: view) }
  }

  /// Starts the element picker: a tap on the page then picks what's under it, and links don't open.
  func startPicking(_ mode: PickMode) {
    guard let view = activeView else { return }
    if readerTab == app.activeTabId {
      readerTab = nil
      Task { _ = try? await view.runScript(.closeReader) }
    }
    Task { [weak self] in
      _ = try? await view.runScript(.startPicker)
      self?.picked = nil
      self?.inspected = nil
      self?.picking = mode
    }
  }

  func endPicking() {
    if let view = activeView { Task { _ = try? await view.runScript(.stopPicker) } }
    pickerGone()
  }

  /// The picker's state goes with its page (a new document, another tab), which stops it anyway.
  private func pickerGone() {
    picking = nil
    picked = nil
    inspected = nil
    if panel == .inspect { panel = nil }
  }

  /// Picks the element around the picked one.
  func pickParent() {
    guard let view = activeView else { return }
    Task { [weak self] in
      let moved = (try? await view.runScript(.pickParent)) == "true"
      if !moved, let self { self.showNotice(self.strings.t("notice.noParent")) }
    }
  }

  func hidePicked() {
    guard let picked else { return }
    let rules = activeHidden
    setHidden(rules.contains(picked.selector) ? rules : rules + [picked.selector])
    self.picked = nil
  }

  func undoHide() {
    setHidden(Array(activeHidden.dropLast()))
  }

  /// Brings back everything hidden on the site showing.
  func showHidden() {
    setHidden([])
  }

  /// Reads what the picked element is, for the inspect sheet.
  func inspectPicked() {
    guard let view = activeView else { return }
    Task { [weak self] in
      guard let text = try? await view.runScript(.inspect), let element = parseInspectedElement(json: text) else { return }
      self?.inspected = element
      self?.panel = .inspect
    }
  }

  func copyInspected() {
    guard let inspected else { return }
    UIPasteboard.general.string = inspected.agent
    showNotice(strings.t("notice.copiedForAgent"))
  }

  // MARK: Reader

  /// Reader on the page showing, with its settings sheet; when Reader already reads it, only the sheet opens.
  func openReader() {
    let tabId = app.activeTabId
    if readerTab == tabId {
      panel = .reader
      return
    }
    guard let view = activeView else { return }
    Task { [weak self] in
      guard let self else { return }
      if await self.startReader(view) {
        self.readerTab = tabId
        self.panel = .reader
      } else {
        if self.panel == .page { self.panel = nil }
        self.showNotice(self.strings.t("notice.noArticle"))
      }
    }
  }

  /// A site that keeps Reader on: as each page there finishes loading, Reader opens by itself, once per address.
  private func openReaderBySite(_ tabId: String, url: String) {
    guard readerTab != tabId, autoReaderUrl != url, !url.isEmpty, app.store.siteSetting(url: url).reader,
      !(locked && activeTab?.private == true), let view = views[tabId]
    else { return }
    autoReaderUrl = url
    Task { [weak self] in
      if await self?.startReader(view) == true, self?.app.activeTabId == tabId { self?.readerTab = tabId }
    }
  }

  /// Runs Reader's open script with the chosen look; false when the page has no article.
  private func startReader(_ view: EngineView) async -> Bool {
    struct Opened: Decodable { let ok: Bool }
    let text = try? await view.runScript(.openReader, args: ["variables": readerVariables(settings: app.preferences.reader)])
    return text.flatMap { try? JSONDecoder().decode(Opened.self, from: Data($0.utf8)) }?.ok ?? false
  }

  func exitReader() {
    panel = nil
    readerTab = nil
    guard let view = activeView else { return }
    Task { _ = try? await view.runScript(.closeReader) }
  }

  /// Keeps Reader's new look and restyles the page Reader is showing.
  func changeReader(_ settings: ReaderSettings) {
    app.dispatch(.readerSettingsChange(settings: ReaderSettingsInput(theme: settings.theme, font: settings.font, size: Double(settings.size))))
    guard readerTab == app.activeTabId, let view = activeView else { return }
    Task { _ = try? await view.runScript(.updateReader, args: ["variables": readerVariables(settings: settings)]) }
  }

  func copyMarkdown() {
    guard let view = activeView else { return }
    Task { [weak self] in
      struct Result: Decodable { let markdown: String }
      guard let text = try? await view.runScript(.markdown),
        let result = try? JSONDecoder().decode(Result.self, from: Data(text.utf8))
      else { return }
      UIPasteboard.general.string = result.markdown
      self?.showNotice(self?.strings.t("notice.markdownCopied") ?? "")
    }
  }

  // MARK: This site's own settings

  /// What the page showing follows: its site's own setting, else every global choice.
  var siteSetting: SiteSetting { app.store.siteSetting(url: activeUrl) }

  /// The page's zoom in percent: its site's own, else Bay's.
  var pageZoom: Int { Int(siteSetting.textSize ?? app.preferences.textSize) }

  func setZoom(_ zoom: Int) {
    let global = Int(app.preferences.textSize)
    changeSiteSetting { $0.textSize = zoom == global ? nil : Double(zoom) }
  }

  func setDesktop(_ on: Bool) {
    changeSiteSetting { $0.desktopMode = on }
  }

  func changeSiteSetting(_ change: (inout SiteSettingInput) -> Void) {
    let host = siteHost(url: activeUrl)
    guard !host.isEmpty else { return }
    let setting = siteSetting
    var input = SiteSettingInput(
      textSize: setting.textSize.map(Double.init), reader: setting.reader, desktopMode: setting.desktopMode, blockOff: setting.blockOff,
      swipe: setting.swipe)
    change(&input)
    app.dispatch(.siteSettings(host: host, update: input))
    preferencesChanged()
  }

  /// A changed preference or site setting reaches the open pages at once.
  func preferencesChanged() {
    for (id, view) in views {
      let url = navigation[id]?.url ?? app.tabs.first { $0.id == id }?.url ?? ""
      configure(view, url: url)
      applyTweaks(id, url: url)
    }
    applyBlockingPauses()
  }

  /// The page view's settings for the page it shows: its site's desktop mode and swipe, and Bay's own choices.
  private func configure(_ view: EngineView, url: String) {
    let preferences = app.preferences
    let setting = url.isEmpty ? SiteSetting(textSize: nil, reader: false, desktopMode: false, blockOff: [], swipe: nil) : app.store.siteSetting(url: url)
    view.desktopMode = setting.desktopMode
    view.swipeMode = setting.swipe ?? preferences.swipeToNavigate
    view.pullToRefreshEnabled = preferences.pullToRefresh
    view.appLinks = preferences.appLinks
  }

  /// Bay's page zoom (the site's own first) and the AMP swap, on the page a tab shows.
  private func applyTweaks(_ tabId: String, url: String) {
    guard let view = views[tabId], isWebUrl(value: url) else { return }
    let setting = app.store.siteSetting(url: url)
    let zoom = setting.textSize ?? app.preferences.textSize
    let skipAmp = app.preferences.skipAmp && !(ampLeft[tabId]?.contains(url) ?? false)
    Task { [weak self] in
      let result = try? await view.runScript(.pageTweaks, args: ["textSize": zoom, "skipAmp": skipAmp])
      if result == "\"amp\"" { self?.ampLeft[tabId, default: []].insert(url) }
    }
  }

  // MARK: Blocking on this page

  var blocking: PageBlocking {
    guard app.preferences.blockContent else { return .off }
    let host = hostOf(url: activeUrl)
    if pausedEntry(host) != nil { return .paused }
    if !host.isEmpty, host == restoredHost { return .restored }
    return .on
  }

  /// The paused host this site falls under: itself or a domain it's part of.
  private func pausedEntry(_ host: String) -> String? {
    guard !host.isEmpty else { return nil }
    return app.preferences.blockingPausedHosts.first { host == $0 || host.hasSuffix(".\($0)") }
  }

  func toggleBlocking() {
    let host = hostOf(url: activeUrl)
    guard !host.isEmpty else { return }
    if restoredHost == host {
      restoredHost = nil
    } else {
      let entry = pausedEntry(host)
      app.dispatch(.pauseBlocking(host: entry ?? host, paused: entry == nil))
    }
    applyBlockingPauses()
    // The change applies to new loads; reload so this page shows it.
    reload()
  }

  /// The page again without blocking, and the question whether that fixed it: yes keeps blocking off for the site;
  /// otherwise it comes back when the tab leaves.
  func restoreOriginal() {
    let host = hostOf(url: activeUrl)
    guard !host.isEmpty else { return }
    restoredHost = host
    applyBlockingPauses()
    reload()
    showToast(strings.t("toast.restoredBlocking"), actionLabel: strings.t("toast.keepBlockingOff")) { [weak self] in
      self?.app.dispatch(.pauseBlocking(host: host, paused: true))
      self?.restoredHost = nil
      self?.applyBlockingPauses()
    }
  }

  private func applyBlockingPauses() {
    Engine.setBlockingPausedHosts(app.preferences.blockingPausedHosts + (restoredHost.map { [$0] } ?? []))
  }

  // MARK: Find on page

  func startFind() {
    find = FindState()
  }

  func findChanged(_ query: String) {
    guard find != nil else { return }
    find?.query = query
    findTimer?.cancel()
    guard let view = activeView else { return }
    if query.isEmpty {
      find?.count = nil
      Task { _ = try? await view.runScript(.findClear) }
      return
    }
    // Typing pauses a moment before the page is searched.
    findTimer = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 150_000_000)
      guard !Task.isCancelled else { return }
      await self?.search(query, in: view)
    }
  }

  private struct Found: Decodable {
    let count: Int
    let index: Int
  }

  private func search(_ query: String, in view: EngineView) async {
    let text = try? await view.runScript(.find, args: ["query": query])
    // A page that can't be searched has nothing to show for these words.
    let found = text.flatMap { try? JSONDecoder().decode(Found.self, from: Data($0.utf8)) } ?? Found(count: 0, index: -1)
    guard find?.query == query else { return }
    find?.count = found.count
    find?.index = found.index
    find?.foundFor = query
  }

  func findStep(_ step: Int) {
    guard let find, let view = activeView else { return }
    // Return right after typing searches now rather than stepping through the old matches.
    if find.foundFor != find.query {
      findTimer?.cancel()
      Task { await search(find.query, in: view) }
      return
    }
    guard (find.count ?? 0) > 0 else { return }
    let query = find.query
    Task { [weak self] in
      guard let text = try? await view.runScript(.findStep, args: ["step": step]),
        let found = try? JSONDecoder().decode(Found.self, from: Data(text.utf8)),
        self?.find?.query == query
      else { return }
      self?.find?.count = found.count
      self?.find?.index = found.index
    }
  }

  func endFind() {
    guard find != nil else { return }
    find = nil
    findTimer?.cancel()
    if let view = activeView { Task { _ = try? await view.runScript(.findClear) } }
  }
}
