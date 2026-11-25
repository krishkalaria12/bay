import Foundation

/// A Chromium profile's last open tabs, read by the shared reader (bay-import), which also opens encrypted (version 5)
/// session files with the browser's key.
public enum ChromiumSessions {
  public static func latestFile(profile: URL) -> URL? {
    let fm = FileManager.default
    var candidates: [(stamp: Int64, url: URL)] = []
    for dir in ["Sessions", "Sessions_Encrypted"] {
      let folder = profile.appendingPathComponent(dir)
      for name in (try? fm.contentsOfDirectory(atPath: folder.path)) ?? [] where name.hasPrefix("Session_") {
        if let stamp = Int64(name.dropFirst("Session_".count)) {
          candidates.append((stamp, folder.appendingPathComponent(name)))
        }
      }
    }
    if let newest = candidates.max(by: { $0.stamp < $1.stamp }) { return newest.url }
    for legacy in ["Current Session", "Last Session"] {
      let url = profile.appendingPathComponent(legacy)
      if fm.fileExists(atPath: url.path) { return url }
    }
    return nil
  }

  public static func load(profile: URL, key: Data?) throws -> OpenTabs {
    var request: [String: Any] = ["reader": "chromiumTabs", "profile": profile.path, "canUnlock": true]
    if let key { request["key"] = key.map { String(format: "%02x", $0) }.joined() }
    return try SharedReaders.read(request, as: SharedReaders.Tabs.self).open
  }
}
