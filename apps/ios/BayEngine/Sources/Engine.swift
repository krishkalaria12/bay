import AVFoundation
import BayCore
import Foundation
import WebKit

/// What every page view shares: audio, content blocking, private browsing, spaces' website data, downloads, media
/// controls, voice search and saved images. The Expo module's functions (`BayEngineModule`), called from Swift.
/// Call from the main thread.
public enum Engine {
  /// Sets up what the app needs before the first page: pages' audio keeps playing with the silent switch on and while
  /// Bay is in the background, as in Safari. `downloads` hears each download's progress; `media` the system's media
  /// controls.
  public static func start(downloads: @escaping (DownloadEvent) -> Void, media: @escaping (MediaControl) -> Void) {
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
    BayDownloads.shared.emit = downloads
    BayMedia.shared.emit = { action in
      if let control = MediaControl(rawValue: action) { media(control) }
    }
  }

  // MARK: Content blocking

  /// Blocks with filter list files (`file://` URIs, EasyList syntax), or stops blocking with nil. `version` names their
  /// contents: WebKit's rules are compiled once per version and reused on later launches. Each list's group (`ads`,
  /// `trackers`, `cookies`, or `shared` for lists every group needs) lets a site turn a group off. Answers with how
  /// many rules WebKit compiled.
  @discardableResult
  public static func setContentBlocking(lists files: [String]?, version: String, groups: [String]? = nil) async throws -> Int {
    // Each group's lists, read only when that group's version still has to be compiled. "shared" lists (the unbreak
    // fixes) go with every group; lists without groups are one group, "all".
    let read: ([String]) -> () -> String? = { files in
      { files.compactMap { URL(string: $0).flatMap { try? String(contentsOf: $0, encoding: .utf8) } }.joined(separator: "\n") }
    }
    let byGroup: [String: () -> String?]? = files.map { files in
      guard let groups, groups.count == files.count else { return ["all": read(files)] }
      let pairs = Array(zip(files, groups))
      let shared = pairs.filter { $0.1 == "shared" }.map(\.0)
      let names = Set(groups).subtracting(["shared"])
      guard !names.isEmpty else { return ["all": read(files)] }
      return Dictionary(uniqueKeysWithValues: names.map { name in (name, read(pairs.filter { $0.1 == name }.map(\.0) + shared)) })
    }
    let paths = files?.compactMap { URL(string: $0)?.path }
    return try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.main.async {
        BayContentBlocker.shared.apply(groups: byGroup, version: version) { continuation.resume(with: $0) }
        BayContentBlocker.shared.loadScriptletEngine(paths: paths, groups: files == nil ? nil : groups, version: version)
      }
    }
  }

  /// Sites (hosts, matching their subdomains) where blocking is paused.
  public static func setBlockingPausedHosts(_ hosts: [String]) {
    BayContentBlocker.shared.setPausedHosts(hosts)
  }

  /// The groups each site turns off, by host (matching its subdomains).
  public static func setSiteBlocking(_ groupsOff: [String: [String]]) {
    guard let data = try? JSONSerialization.data(withJSONObject: groupsOff), let json = String(data: data, encoding: .utf8) else { return }
    BayContentBlocker.shared.setSiteGroups(json)
  }

  /// The tracking-parameter table (`@bay/core`'s `TRACKING_PARAMS` as JSON) stripped from main-frame navigations.
  @discardableResult
  public static func setTrackingParameters(_ json: String) -> Bool {
    BayTracking.setParameters(json)
  }

  // MARK: Sessions and data

  /// Whether the app has private tabs, mounted or not: the private session lasts while this is true.
  public static func setPrivateSessionActive(_ active: Bool) {
    BayPrivateBrowsing.setActive(active)
  }

  /// Clears cookies, website storage, network cache, snapshots and saved tab states in every space's store. Close page
  /// views first so pages can't write fresh data.
  public static func clearData() async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      BaySpaceProfiles.clearAll {
        do {
          try BayEngineSnapshots.clear()
          try BayEngineTabStates.clear()
          continuation.resume()
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }
  }

  /// Deletes a space's website data, as deleting the space does.
  public static func deleteProfile(_ profile: String) async {
    await withCheckedContinuation { continuation in
      BaySpaceProfiles.delete(profile) { continuation.resume() }
    }
  }

  /// Deletes snapshots that aren't in `keep` (file URLs).
  public static func pruneSnapshots(keeping keep: [String]) {
    BayEngineSnapshots.prune(keeping: keep)
  }

  /// Deletes saved tab states whose tab ids aren't in `keep`.
  public static func pruneTabStates(keeping keep: [String]) {
    BayEngineTabStates.prune(keeping: keep)
  }

  // MARK: Downloads, images, media and voice

  /// Shows a downloaded file in Quick Look.
  public static func openDownload(_ path: String) throws {
    try BayDownloads.shared.open(path)
  }

  public static func cancelDownload(_ id: String) {
    BayDownloads.shared.cancel(id)
  }

  /// Saves a web image to the photo library, asking for access the first time.
  public static func saveImage(_ url: String) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      BayImages.save(url) { continuation.resume(with: $0) }
    }
  }

  /// Posts what's playing to the lock screen and Control Center, or clears it with nil.
  public static func setMediaSession(title: String?, site: String, playing: Bool) {
    if let title {
      BayMedia.shared.update(title: title, site: site, playing: playing)
    } else {
      BayMedia.shared.clear()
    }
  }

  /// Listens once and answers with what was said, or nil (speech or microphone refused, nothing heard).
  public static func listen() async -> String? {
    await withCheckedContinuation { continuation in
      DispatchQueue.main.async { BayVoice.listen { continuation.resume(returning: $0) } }
    }
  }
}
