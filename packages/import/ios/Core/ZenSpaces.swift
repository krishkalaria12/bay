import Foundation

// Zen's spaces (its "workspaces"): each with its pinned tabs and folders and its open tabs, and the essentials of its
// container on top. Zen keeps them in zen-sessions.jsonlz4 (1.14 and later), and before that in the session store's
// window, in the same shape: `spaces`, `folders` and `tabs` whose `zenWorkspace`, `zenEssential` and `groupId` place
// them. Firefox's own reading of the session store (Firefox.session) flattens all of that into one list of tabs.
public enum ZenSpaces {
  /// The spaces of a Zen profile, read by the shared reader (bay-import); nil when it has none.
  public static func load(profile: URL, profileId: String) throws -> [SpaceSuggestion]? {
    let spaces = try SharedReaders.read(["reader": "zenSpaces", "profile": profile.path, "profileId": profileId],
                                        as: [SpaceSuggestion].self)
    return spaces.isEmpty ? nil : spaces
  }

  /// The spaces in a zen-sessions document or a session store; nil when it has none (Firefox, or Zen without spaces).
  public static func parse(_ json: Data, profileId: String) throws -> [SpaceSuggestion]? {
    let spaces = try SharedReaders.read(["reader": "zenSpaces", "text": String(decoding: json, as: UTF8.self), "profileId": profileId],
                                        as: [SpaceSuggestion].self)
    return spaces.isEmpty ? nil : spaces
  }
}
