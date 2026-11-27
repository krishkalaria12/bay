import Foundation

public struct ArcSidebar: Equatable, Decodable {
  public var spaces: [SpaceSuggestion] = []
  public var favorites: [String: [ImportedTab]] = [:]

  /// Arc's StorableSidebar.json, read by the shared reader (bay-import).
  public static func parse(_ data: Data) throws -> ArcSidebar {
    try SharedReaders.read(["reader": "arcSidebar", "text": String(decoding: data, as: UTF8.self)], as: ArcSidebar.self)
  }
}
