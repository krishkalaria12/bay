import Foundation

/// A Chromium profile's bookmarks (Bookmarks and the account's AccountBookmarks), read by the shared reader
/// (bay-import).
public enum ChromiumBookmarks {
  public static func load(profile: URL) throws -> BookmarkNode {
    try SharedReaders.read(["reader": "chromiumBookmarks", "profile": profile.path], as: BookmarkNode.self)
  }
}
