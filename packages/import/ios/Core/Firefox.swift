import Foundation

public enum Firefox {
  public struct Profile: Equatable {
    public var name: String
    public var path: String
    public var isDefault: Bool
  }

  public static func profiles(ini: String) -> [Profile] {
    var sections: [(name: String, values: [String: String])] = []
    for raw in ini.split(whereSeparator: \.isNewline) {
      let line = raw.trimmingCharacters(in: .whitespaces)
      if line.isEmpty || line.hasPrefix(";") || line.hasPrefix("#") { continue }
      if line.hasPrefix("["), line.hasSuffix("]") {
        sections.append((String(line.dropFirst().dropLast()), [:]))
      } else if let eq = line.firstIndex(of: "="), !sections.isEmpty {
        sections[sections.count - 1].values[String(line[..<eq])] = String(line[line.index(after: eq)...])
      }
    }
    let installDefaults = Set(sections.filter { $0.name.hasPrefix("Install") }.compactMap { $0.values["Default"] })
    var out: [Profile] = []
    for s in sections where s.name.hasPrefix("Profile") {
      guard let path = s.values["Path"], !path.isEmpty else { continue }
      let isDefault = installDefaults.isEmpty ? s.values["Default"] == "1" : installDefaults.contains(path)
      out.append(Profile(name: s.values["Name"] ?? path, path: path, isDefault: isDefault))
    }
    return out.sorted { $0.isDefault && !$1.isDefault }
  }

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

  // cookies.sqlite is plaintext on disk: no key or primary password involved.
  public static func cookies(profile: URL, cancellation: Cancellation = .init()) throws -> CookieOutcome {
    try cookies(database: profile.appendingPathComponent("cookies.sqlite"), cancellation: cancellation)
  }

  public static func cookies(database: URL, cancellation: Cancellation = .init()) throws -> CookieOutcome {
    let db = try SQLiteSnapshot(copying: database)
    guard db.tableExists("moz_cookies") else { throw ImportError.unreadable("cookies.sqlite has no cookies") }
    let now = Date().timeIntervalSince1970 * 1000
    var out: [Cookie] = []
    var skipped = 0
    var seen = 0
    try db.query("SELECT * FROM moz_cookies") { row in
      seen += 1
      if seen % 256 == 0 { try cancellation.check() }
      guard let host = row.text("host"), let name = row.text("name") else { return true }
      let attributes = originAttributes(row.text("originAttributes") ?? "")
      if attributes.isolated {
        skipped += 1
        return true
      }
      // Older Firefox stored expiry in seconds, newer in milliseconds.
      let expiry = row.int("expiry").flatMap { $0 > 0 ? Double($0) : nil }.map { $0 > 100_000_000_000 ? $0 : $0 * 1000 }
      if let expiry, expiry < now { return true }
      let secure = (row.int("isSecure") ?? 0) != 0
      let schemeMap = row.int("schemeMap") ?? 0
      out.append(Cookie(
        domain: host,
        name: name,
        value: row.secret("value") ?? SecretBytes(count: 0),
        path: row.text("path").flatMap { $0.isEmpty ? nil : $0 } ?? "/",
        created: row.int("creationTime").flatMap(Time.fromUnixMicros),
        expires: expiry,
        lastAccess: row.int("lastAccessed").flatMap(Time.fromUnixMicros),
        secure: secure,
        httpOnly: (row.int("isHttpOnly") ?? 0) != 0,
        sameSite: sameSite(row.int("sameSite"), raw: row.int("rawSameSite"), secure: secure),
        priority: "medium",
        partition: attributes.partition,
        sourceScheme: schemeMap & 2 != 0 ? "secure" : schemeMap & 1 != 0 ? "nonSecure" : "unset",
        sourcePort: -1
      ))
      return true
    }
    return CookieOutcome(items: out, skipped: skipped)
  }

  // nsICookie: SAMESITE_NONE 0, LAX 1, STRICT 2, UNSET 256 (newer). Older Firefox kept what the site sent in
  // rawSameSite; a differing value means Firefox applied its own default. NONE also meant "not set" in older
  // Firefox, and Chromium rejects SameSite=None without Secure, so an insecure NONE becomes unspecified.
  static func sameSite(_ value: Int64?, raw: Int64?, secure: Bool) -> String {
    if let raw, let value, raw != value { return "unspecified" }
    switch value {
    case 0: return secure ? "none" : "unspecified"
    case 1: return "lax"
    case 2: return "strict"
    default: return "unspecified"
    }
  }

  /// Parses an originAttributes suffix such as `^partitionKey=%28https%2Cexample.com%29&userContextId=2`.
  /// `isolated` (containers, private browsing, first-party isolation) and a partition key that can't be turned
  /// into a Chromium top-level site both mean "don't import".
  static func originAttributes(_ suffix: String) -> (isolated: Bool, partition: CookiePartition?) {
    var text = Substring(suffix)
    if text.hasPrefix("^") { text = text.dropFirst() }
    var isolated = false
    var partition: CookiePartition?
    for pair in text.split(separator: "&") where !pair.isEmpty {
      let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      guard let first = parts.first, !first.isEmpty else {
        isolated = true  // Malformed: don't guess which jar it belongs to.
        continue
      }
      let key = String(first)
      let value = parts.count > 1 ? (String(parts[1]).removingPercentEncoding ?? String(parts[1])) : ""
      switch key {
      case "userContextId", "privateBrowsingId":
        if value != "0" && !value.isEmpty { isolated = true }
      case "firstPartyDomain", "geckoViewSessionContextId":
        if !value.isEmpty { isolated = true }
      case "partitionKey":
        guard let site = partitionSite(value) else {
          isolated = true
          continue
        }
        partition = CookiePartition(topLevelSite: site, crossSite: false)
      default:
        continue
      }
    }
    return (isolated, partition)
  }

  /// `(https,example.com[,port])` → `https://example.com` (Chromium's schemeful site has no port).
  static func partitionSite(_ key: String) -> String? {
    guard key.hasPrefix("("), key.hasSuffix(")") else { return nil }
    let fields = key.dropFirst().dropLast().split(separator: ",", omittingEmptySubsequences: false).map(String.init)
    guard fields.count == 2 || fields.count == 3, fields[0] == "https" || fields[0] == "http" else { return nil }
    if fields.count == 3 { guard let port = Int(fields[2]), (1...65535).contains(port) else { return nil } }
    let host = fields[1].lowercased()
    let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789.-_")
    guard !host.isEmpty, !host.hasPrefix("."), !host.hasSuffix("."), host.allSatisfy(allowed.contains) else { return nil }
    return "\(fields[0])://\(host)"
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
