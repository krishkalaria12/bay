import BayCore
import BayEngine
import Foundation
import UIKit

/// Settings' state: the pages open over its index, how far clearing browsing data has got, and what the core needs to
/// write the pages (`context`). The core writes every page; this runs what its rows ask for (`perform`).
@MainActor
final class SettingsModel: ObservableObject {
  let app: AppModel
  let browser: BrowserModel
  let strings: Strings
  @Published var visible = false
  /// The saved sign-ins Settings › Passwords lists, read when Settings opens and after one is forgotten.
  @Published private(set) var logins: [LoginSummary] = []
  /// The pages over the index, the one in front last.
  @Published var stack: [SettingsPage] = []
  @Published private(set) var clearStage: ClearStage = .idle
  /// The row a search opened a page at, lit for a moment.
  @Published var focus: String?
  /// The home screen icon, or nil where the phone can't change it.
  @Published private(set) var appIcon: AppIcon?

  init(app: AppModel, browser: BrowserModel, strings: Strings) {
    self.app = app
    self.browser = browser
    self.strings = strings
    appIcon = AppIcon.supported ? AppIcon.current : nil
  }

  /// Puts an icon on the home screen; when iOS refuses, the picker goes back to the icon that stayed.
  func chooseAppIcon(_ icon: AppIcon) {
    guard let before = appIcon, icon != before else { return }
    appIcon = icon
    Task {
      do { try await icon.apply() } catch { appIcon = before }
    }
  }

  func open() {
    logins = app.logins.summaries()
    stack = []
    clearStage = .idle
    visible = true
  }

  func close() {
    visible = false
  }

  func push(_ pages: [SettingsPage]) {
    stack += pages
  }

  func pop() {
    if !stack.isEmpty { stack.removeLast() }
  }

  var context: SettingsContext {
    let prefs = app.preferences
    return SettingsContext(
      locale: strings.locale,
      platform: .ios,
      version: version,
      prefs: prefs,
      engines: builtInEngines().map { EngineChoice(id: $0.id, name: $0.name) },
      blockerDetail: blockerDetail,
      wallpaperName: strings.t("settings.wallpapers.\(prefs.wallpaper)"),
      appIconName: appIcon.map { strings.t($0.label) },
      language: LanguageState(saved: strings.saved, current: strings.locale, device: strings.device),
      defaultBrowser: DefaultBrowserStatus.current,
      openTabCount: UInt32(app.allTabs.count),
      logins: logins,
      clearStage: clearStage,
      sync: app.syncView,
      now: AppModel.now())
  }

  /// The version Bay shows in About and puts on problem reports.
  private var version: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
  }

  /// What Privacy says about the blocker under its switch.
  private var blockerDetail: String {
    switch app.blockerStatus {
    case .ready(let lists): return strings.t("settings.blocker.ready", ["lists": "\(lists)"])
    case .loading: return strings.t("settings.blocker.loading")
    case .failed: return strings.t("settings.blocker.failed")
    case .off: return strings.t("settings.blocker.off")
    }
  }

  var counts: IndexCounts {
    let space = app.activeSpaceId
    let history = app.store.history(spaceId: space, query: "", offset: 0, limit: 10_000).count
    let bookmarks = app.store.bookmarkListing(spaceId: space, folderId: "bookmarks", query: "").links
    return IndexCounts(bookmarks: bookmarks, history: UInt32(history), downloads: UInt32(app.downloads.count),
      crashes: UInt32(app.crashLog.reports().count))
  }

  /// Opens an index entry: a page (or the page a search found a row on), or one of the browser's own sheets.
  func open(_ entry: IndexEntry, match: SettingsMatch? = nil) {
    switch entry {
    case .page(let page):
      focus = match?.row
      push(match?.page.map { settingsPath(page: $0) } ?? [page])
    case .action(let action):
      // The browser's own sheets open over Settings.
      switch action {
      // The drawer slides over the page, so Settings goes first.
      case .bookmarks:
        close()
        browser.openDrawer()
      case .history: browser.panel = .history
      case .downloads: browser.panel = .downloads
      case .import: browser.panel = .import
      case .report: reportProblem()
      }
    }
  }

  /// Does what a row asks.
  func perform(_ action: SettingsAction) {
    switch action {
    case .change(let update): app.dispatch(.preferences(update: update))
    case .chooseEngine(let id): app.dispatch(.searchEngine(id: id, customUrl: nil))
    case .setArchiveAfterDays(let days): app.dispatch(.archiveDays(days: days))
    case .setBlockContent(let on): app.dispatch(.blockContent(enabled: on))
    case .resumeBlocking(let host): app.dispatch(.pauseBlocking(host: host, paused: false))
    case .setLockPrivateTabs(let on): app.dispatch(.lockPrivateTabs(enabled: on))
    case .setLanguage(let locale): strings.choose(locale)
    case .makeDefault: DefaultBrowserStatus.openSetting()
    case .exportTabs: exportTabs()
    case .forgetLogin(let login):
      app.logins.forget(origin: login.origin, username: login.username)
      logins = app.logins.summaries()
    case .askToClear: clearStage = .confirming
    case .keepData: clearStage = .idle
    case .confirmClear: clear()
    case .showWelcome: app.dispatch(.welcomeAgain)
    case .openLink(let url), .openSyncedTab(let url):
      close()
      browser.openTab(url)
    case .syncNow: app.syncNow()
    case .setSyncType(let kind, let on): app.sync.setType(kind: kind, on: on)
    case .leaveSync: app.leave()
    }
  }

  /// Clears browsing data: every page view goes first (a page still open could write fresh data), the store starts
  /// afresh, then the engine clears what pages kept in every space. Settings closes over the empty start page.
  private func clear() {
    guard clearStage != .busy else { return }
    clearStage = .busy
    browser.closeAllPages()
    app.store.reset(newTabId: UUID().uuidString, now: AppModel.now())
    Task {
      do {
        try await Engine.clearData()
        clearStage = .idle
        close()
      } catch {
        clearStage = .failed
      }
    }
  }

  /// The open tabs' addresses, one a line, without their tracking parameters; private tabs stay out.
  private func exportTabs() {
    let urls = app.allTabs.filter { !$0.url.isEmpty && !$0.private }.map { cleanUrl(url: $0.url) }
    guard !urls.isEmpty else { return }
    present(UIActivityViewController(activityItems: [urls.joined(separator: "\n")], applicationActivities: nil))
  }

  /// Shares the crashes kept, or says there were none.
  private func reportProblem() {
    let text = app.crashLog.text(version: version) ?? strings.t("crash.none")
    present(UIActivityViewController(activityItems: [text], applicationActivities: nil))
  }
}

/// Presents a view controller over whatever is on screen.
@MainActor
func present(_ controller: UIViewController) {
  let window = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow }
  var top = window?.rootViewController
  while let presented = top?.presentedViewController { top = presented }
  top?.present(controller, animated: true)
}
