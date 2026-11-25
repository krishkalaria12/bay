import Foundation

public enum Firefox {
  // MARK: Bookmarks

  /// A profile's bookmarks (places.sqlite), read by the shared reader (bay-import).
  public static func bookmarks(places: URL, cancellation: Cancellation = .init()) throws -> BookmarkNode {
    try SharedReaders.read(["reader": "firefoxBookmarks", "profile": places.deletingLastPathComponent().path],
                           as: BookmarkNode.self, cancellation: cancellation)
  }

  // MARK: Cookies

  public struct CookieOutcome {
    public var items: [Cookie]
    /// Cookies from containers, private browsing, first-party isolation, or with a partition key that has no
    /// exact Chromium equivalent: not imported.
    public var skipped: Int
  }

  // cookies.sqlite is plaintext on disk: no key or primary password involved. Read by the shared reader.
  public static func cookies(profile: URL, cancellation: Cancellation = .init()) throws -> CookieOutcome {
    try cookies(["profile": profile.path], cancellation: cancellation)
  }

  public static func cookies(database: URL, cancellation: Cancellation = .init()) throws -> CookieOutcome {
    try cookies(["database": database.path], cancellation: cancellation)
  }

  private static func cookies(_ source: [String: Any], cancellation: Cancellation) throws -> CookieOutcome {
    struct Answer: Decodable {
      var cookies: [SharedReaders.CookieAnswer]
      var skipped: Int
    }
    let secrets = SharedReaders.Secrets()
    defer { secrets.wipe() }
    let request = source.merging(["reader": "firefoxCookies"]) { a, _ in a }
    let answer = try SharedReaders.read(request, as: Answer.self, cancellation: cancellation, secrets: secrets)
    return CookieOutcome(items: answer.cookies.map { $0.cookie(secrets) }, skipped: answer.skipped)
  }

  // MARK: Session store

  public static func sessionFile(profile: URL) -> URL? {
    let candidates = ["sessionstore-backups/recovery.jsonlz4", "sessionstore.jsonlz4", "sessionstore-backups/previous.jsonlz4"]
      .map { profile.appendingPathComponent($0) }
      .filter { FileManager.default.fileExists(atPath: $0.path) }
    return candidates.max { modified($0) < modified($1) }
  }

  private static func modified(_ url: URL) -> Date {
    (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
  }

  /// The tabs in a session store's JSON (decompressed), read by the shared reader (bay-import).
  public static func session(_ json: Data) throws -> OpenTabs {
    try SharedReaders.read(["reader": "firefoxTabs", "text": String(decoding: json, as: UTF8.self)], as: SharedReaders.Tabs.self).open
  }

  /// A profile's last open tabs, from its newest session store.
  public static func loadSession(profile: URL) throws -> OpenTabs {
    try SharedReaders.read(["reader": "firefoxTabs", "profile": profile.path], as: SharedReaders.Tabs.self).open
  }
}
