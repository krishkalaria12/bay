import BayCore
import BayEngine
import Foundation
import UIKit

/// The app's view of the core: the browser store's slices screens read, and sync's view, refreshed whenever either
/// changes. Every change goes through the core; nothing here edits state of its own.
@MainActor
final class AppModel: ObservableObject {
  let store: BrowserStore
  let sync: PhoneSync
  let http = URLSessionHttp()
  /// The crashes kept for Settings › Report a problem.
  let crashLog: CrashLog
  private let crashWatch: CrashWatch
  @Published private(set) var spaces: [BrowserSpace] = []
  @Published private(set) var activeSpaceId = ""
  @Published private(set) var activeTabId = ""
  /// The tabs of the space showing, in list order.
  @Published private(set) var tabs: [BrowserTab] = []
  @Published private(set) var preferences: BrowserPreferences
  @Published private(set) var syncView: SyncView
  /// Where the link check's link ended, while the stand-in screens prove the HTTP client.
  @Published private(set) var resolved: String?
  /// Downloads, newest first.
  @Published private(set) var downloads: [DownloadItem] = []
  /// The space's pinned pages: Essentials and rows.
  @Published private(set) var pins: [PinnedSite] = []
  /// The space's folders of pinned rows.
  @Published private(set) var folders: [BrowserFolder] = []
  /// The space's latest history, newest first, for the start page.
  @Published private(set) var recentHistory: [HistoryEntry] = []
  /// Saved site icons (local file addresses) by host.
  @Published private(set) var favicons: [String: String] = [:]
  /// What the content blocker is doing, for Settings.
  @Published private(set) var blockerStatus: ContentBlocker.Status = .off
  private var blocker: ContentBlocker?
  /// Sign-ins saved from the HTTP sign-in sheet, in the keychain.
  let logins: SavedLogins
  /// Whether the engine keeps the private session for tabs whose views are unloaded.
  private var privateSession = false
  /// The store's revision: sheets that read the store directly (history, the archive, bookmarks) redraw when it moves.
  @Published private(set) var revision: UInt64 = 0
  /// Hears each download update once the store has it, for the download toast.
  var downloadUpdated: ((DownloadEvent) -> Void)?
  /// Hears the system's media controls (lock screen, Control Center): the screen showing the media sets it.
  var mediaControl: ((MediaControl) -> Void)?

  /// How often the phone syncs while Bay is in front, and how long after a change.
  private static let cycleInterval: UInt64 = 30_000_000_000
  private static let afterChange: UInt64 = 3_000_000_000
  private static let pairingPoll: UInt64 = 2_000_000_000

  private var cycles: Task<Void, Never>?
  private var kick: Task<Void, Never>?
  private var pairing: Task<Void, Never>?

  init(barTitle: String) {
    let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].path
    crashLog = CrashLog(documentsDir: documents)
    crashWatch = CrashWatch(log: crashLog)
    logins = SavedLogins(secrets: KeychainSecrets())
    store = BrowserStore.open(documentsDir: documents, newTabId: UUID().uuidString, now: Self.now())
    sync = PhoneSync(
      store: store, http: http, secrets: KeychainSecrets(), documentsDir: documents,
      deviceName: UIDevice.current.name, barTitle: barTitle, relayUrl: nil
    )
    preferences = store.preferences()
    syncView = sync.view()
    // Downloads keep reporting after their tab closes, so the store hears them here.
    Engine.start(
      downloads: { [weak self, store] update in
        _ = store.dispatch(action: .download(update: update, now: Self.now()))
        Task { @MainActor in self?.downloadUpdated?(update) }
      },
      media: { [weak self] control in self?.mediaControl?(control) }
    )
    store.observe(observer: StoreChanges(model: self))
    sync.observe(observer: SyncChanges(model: self))
    blocker = ContentBlocker(documentsDir: documents, http: http) { [weak self] status in self?.blockerStatus = status }
    refresh()
  }

  /// Milliseconds since 1970, as the store's timestamps are.
  static func now() -> Int64 {
    Int64(Date().timeIntervalSince1970 * 1000)
  }

  @discardableResult
  func dispatch(_ action: Action) -> Bool {
    store.dispatch(action: action)
  }

  /// Follows a link's redirects without opening it, as the link menu will.
  func resolve(_ url: String) {
    Task { resolved = await resolveLink(http: http, url: url) ?? "no answer" }
  }

  /// Saves at once: as the app leaves the foreground.
  func flush() {
    try? store.flush()
  }

  // MARK: Sync

  /// Syncs every half minute while Bay is in front.
  func startSyncing() {
    cycles?.cancel()
    cycles = Task { [sync] in
      while !Task.isCancelled {
        await sync.syncNow()
        try? await Task.sleep(nanoseconds: Self.cycleInterval)
      }
    }
  }

  func stopSyncing() {
    cycles?.cancel()
    kick?.cancel()
  }

  func syncNow() {
    Task { [sync] in await sync.syncNow() }
  }

  /// Shows a code and asks every two seconds whether a computer has let this phone in.
  func pair() {
    pairing?.cancel()
    pairing = Task { [sync] in
      var state = await sync.startPairing()
      while !Task.isCancelled, case .waiting = state {
        try? await Task.sleep(nanoseconds: Self.pairingPoll)
        guard let next = await sync.pollPairing() else { return }
        state = next
      }
    }
  }

  func cancelPairing() {
    pairing?.cancel()
    sync.cancelPairing()
  }

  /// Joins with the recovery phrase; the problem with it when it doesn't read.
  func join(phrase: String) async -> String? {
    do {
      try await sync.joinWithPhrase(text: phrase)
      return nil
    } catch {
      return "\(error)"
    }
  }

  func leave() {
    Task { [sync] in await sync.leave() }
  }

  // MARK: Changes

  fileprivate func storeChanged() {
    refresh()
    // A change to what syncs: a cycle a moment later, once a burst of changes has settled.
    kick?.cancel()
    kick = Task { [sync] in
      try? await Task.sleep(nanoseconds: Self.afterChange)
      guard !Task.isCancelled else { return }
      await sync.syncNow()
    }
  }

  fileprivate func syncChanged(_ view: SyncView) {
    syncView = view
  }

  private func refresh() {
    spaces = store.spaces()
    activeSpaceId = store.activeSpaceId()
    activeTabId = store.activeTabId()
    tabs = store.spaceTabs(spaceId: activeSpaceId)
    preferences = store.preferences()
    blocker?.follow(preferences)
    downloads = store.downloads()
    pins = store.pinnedSites(spaceId: activeSpaceId)
    folders = store.folders(spaceId: activeSpaceId)
    recentHistory = store.history(spaceId: activeSpaceId, query: "", offset: 0, limit: 24)
    favicons = store.favicons()
    revision = store.revision()
    let hasPrivate = store.tabs().contains { $0.private }
    if hasPrivate != privateSession {
      privateSession = hasPrivate
      Engine.setPrivateSessionActive(hasPrivate)
    }
  }
}

/// Hears the store's changes on whatever thread made them and refreshes the model on the main one.
private final class StoreChanges: StoreObserver, @unchecked Sendable {
  private weak var model: AppModel?

  init(model: AppModel) {
    self.model = model
  }

  func changed(revision _: UInt64) {
    Task { @MainActor [weak model] in model?.storeChanged() }
  }
}

private final class SyncChanges: SyncObserver, @unchecked Sendable {
  private weak var model: AppModel?

  init(model: AppModel) {
    self.model = model
  }

  func changed(view: SyncView) {
    Task { @MainActor [weak model] in model?.syncChanged(view) }
  }
}
