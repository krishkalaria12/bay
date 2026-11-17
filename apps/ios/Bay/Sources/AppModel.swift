import BayCore
import Foundation

/// The app's view of the core's browser store: the slices screens read, refreshed whenever the store changes. Every
/// change goes through `dispatch`; nothing here edits state of its own.
@MainActor
final class AppModel: ObservableObject {
  let store: BrowserStore
  @Published private(set) var spaces: [BrowserSpace] = []
  @Published private(set) var activeSpaceId = ""
  @Published private(set) var activeTabId = ""
  /// The tabs of the space showing, in list order.
  @Published private(set) var tabs: [BrowserTab] = []
  @Published private(set) var preferences: BrowserPreferences

  init() {
    let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    store = BrowserStore.open(documentsDir: documents.path, newTabId: UUID().uuidString, now: Self.now())
    preferences = store.preferences()
    store.observe(observer: StoreChanges(model: self))
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

  /// Saves at once: as the app leaves the foreground.
  func flush() {
    try? store.flush()
  }

  fileprivate func refresh() {
    spaces = store.spaces()
    activeSpaceId = store.activeSpaceId()
    activeTabId = store.activeTabId()
    tabs = store.spaceTabs(spaceId: activeSpaceId)
    preferences = store.preferences()
  }
}

/// Hears the store's changes on whatever thread made them and refreshes the model on the main one.
private final class StoreChanges: StoreObserver, @unchecked Sendable {
  private weak var model: AppModel?

  init(model: AppModel) {
    self.model = model
  }

  func changed(revision _: UInt64) {
    Task { @MainActor [weak model] in model?.refresh() }
  }
}
