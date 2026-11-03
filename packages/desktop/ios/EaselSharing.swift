import AppKit
import Security

enum EaselSharing {
  static var enabled: Bool { ProcessInfo.processInfo.environment["BAY_EASEL_WEB_SHARING"] == "true" }

  static func failure(_ message: String) -> NSError {
    NSError(domain: "BayEaselSharing", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }

  static func identity() throws -> [String: String] {
    var bytes = [UInt8](repeating: 0, count: 48)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw failure("Couldn't create a secure sharing link. Try again.")
    }
    let hex = bytes.map { String(format: "%02x", $0) }.joined()
    return ["id": String(hex.prefix(32)), "key": String(hex.suffix(64))]
  }

  static func readRecords() throws -> String? {
    let url = try ShellModule.documentURL("easel-shares.json")
    let data: Data
    do { data = try Data(contentsOf: url) }
    catch let error as NSError {
      if error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError { return nil }
      throw failure("Couldn't read Easel sharing records. Restore access to easel-shares.json before changing shared pages.")
    }
    guard let text = String(data: data, encoding: .utf8) else {
      throw failure("Easel sharing records are not valid UTF-8. Restore easel-shares.json before changing shared pages.")
    }
    return text
  }

  // Publish only the rendered canvas and explicit source links. Local paths, profiles and live sessions stay here.
  static func snapshot(_ string: String) throws -> String {
    guard let doc = EaselFiles.parse(string), let items = doc["items"] as? [[String: Any]] else {
      throw failure("Couldn't read this Easel.")
    }
    var cache: [String: NSImage] = [:]
    EaselDrawing.cacheImages(items, into: &cache)
    for item in items where item["kind"] as? String == "image" {
      guard let path = item["path"] as? String, cache[path] != nil else {
        throw failure("An image is unavailable. Restore or remove it before sharing.")
      }
    }
    var image: Any = NSNull()
    if !items.isEmpty {
      guard let rendered = EaselDrawing.render(doc, cache: cache),
            let png = NSBitmapImageRep(cgImage: rendered).representation(using: .png, properties: [:]) else {
        throw failure("Couldn't render this Easel. Try again.")
      }
      guard png.count <= 12_000_000 else { throw failure("This Easel is too large to share. Export it as HTML instead.") }
      image = ["data": "data:image/png;base64," + png.base64EncodedString(), "width": rendered.width, "height": rendered.height]
    }
    var links: [[String: String]] = []
    var seen = Set<String>()
    for item in items {
      let source = item["source"] as? [String: Any]
      guard let value = (source?["url"] as? String) ?? (item["url"] as? String),
            let url = EaselFiles.safeURL(value), seen.insert(url.absoluteString).inserted else { continue }
      links.append(["url": url.absoluteString, "title": (source?["title"] as? String) ?? (item["text"] as? String) ?? value])
    }
    let snapshot: [String: Any] = [
      "version": 1, "title": doc["title"] as? String ?? "Untitled Easel",
      "background": doc["background"] as? String ?? "#FFFFFF", "image": image, "links": links,
    ]
    let data = try JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys])
    guard data.count <= 16 * 1024 * 1024 else { throw failure("This Easel is too large to share. Export it as HTML instead.") }
    guard let result = String(data: data, encoding: .utf8) else { throw failure("Couldn't prepare this Easel for sharing.") }
    return result
  }
}
