import Foundation

/// A Netscape bookmark file (every browser's HTML export), read by the shared reader (bay-import).
public enum NetscapeBookmarks {
  public static func parse(_ html: String) -> BookmarkNode {
    (try? SharedReaders.read(["reader": "netscapeBookmarks", "text": html], as: BookmarkNode.self)) ?? .folder("Bookmarks", [])
  }

  public static func load(_ url: URL) throws -> BookmarkNode {
    let data = try Data(contentsOf: url)
    guard let html = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) else {
      throw ImportError.unreadable("Couldn't read \(url.lastPathComponent)")
    }
    let root = parse(html)
    guard root.linkCount > 0 || !(root.children ?? []).isEmpty else {
      throw ImportError.unreadable("\(url.lastPathComponent) has no bookmarks")
    }
    return root
  }
}
