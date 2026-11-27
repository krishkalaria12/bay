import BayCore
import BayEngine
import Foundation

/// The content blocker: the engine blocks with the filter lists while "Block ads and trackers" is on, and the lists
/// stay fresh. Turning blocking on applies the lists already downloaded, then refreshes the stale ones and applies
/// again if any changed; turning it off stops a refresh still running, so nothing it was doing lands afterwards.
@MainActor
final class ContentBlocker {
  enum Status: Equatable {
    case off, loading, ready(lists: Int), failed
  }

  private let lists: FilterListStore
  private let http: HttpClient
  private let changed: (Status) -> Void
  private var enabled: Bool?
  private var sites: [String: [String]]?
  private var work: Task<Void, Never>?

  init(documentsDir: String, http: HttpClient, changed: @escaping (Status) -> Void) {
    lists = FilterListStore(documentsDir: documentsDir)
    self.http = http
    self.changed = changed
    // The same table for every page, so it is set once.
    _ = Engine.setTrackingParameters(trackingParametersJson())
  }

  /// Follows the preferences: blocking on or off, and what each site turns off on its own.
  func follow(_ preferences: BrowserPreferences) {
    let groupsOff = preferences.siteSettings.compactMapValues { setting in
      setting.blockOff.isEmpty ? nil : setting.blockOff.map { "\($0)" }
    }
    if groupsOff != sites {
      sites = groupsOff
      Engine.setSiteBlocking(groupsOff)
    }
    guard preferences.blockContent != enabled else { return }
    enabled = preferences.blockContent
    work?.cancel()
    work = Task { [weak self] in
      guard let self else { return }
      if preferences.blockContent { await self.turnOn() } else { await self.turnOff() }
    }
  }

  private func turnOn() async {
    await apply()
    guard !Task.isCancelled else { return }
    let lists = lists
    let http = http
    let now = AppModel.now()
    // Off the main thread: up to 7 MB of lists to fetch, compare and write.
    let refreshed = await Task.detached { await lists.refresh(http: http, now: now) }.value
    if refreshed, !Task.isCancelled { await apply() }
  }

  /// Hands the engine the lists on disk, or says they are still coming when there are none yet.
  private func apply() async {
    let lists = lists
    // Off the main thread: the version comes from hashing every list's text.
    let present = await Task.detached { lists.onDisk() }.value
    guard !present.uris.isEmpty else {
      changed(.loading)
      return
    }
    do {
      try await Engine.setContentBlocking(lists: present.uris, version: present.version, groups: present.groups)
      if !Task.isCancelled { changed(.ready(lists: present.uris.count)) }
    } catch {
      changed(.failed)
    }
  }

  private func turnOff() async {
    _ = try? await Engine.setContentBlocking(lists: nil, version: "")
    changed(.off)
  }
}
