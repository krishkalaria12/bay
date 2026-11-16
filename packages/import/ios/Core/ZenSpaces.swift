import Foundation

// Zen's spaces (its "workspaces"): each with its pinned tabs and folders and its open tabs, and the essentials of its
// container on top. Zen keeps them in zen-sessions.jsonlz4 (1.14 and later), and before that in the session store's
// window, in the same shape: `spaces`, `folders` and `tabs` whose `zenWorkspace`, `zenEssential` and `groupId` place
// them. Firefox's own reading of the session store (Firefox.session) flattens all of that into one list of tabs.
public enum ZenSpaces {
  public static func load(profile: URL, profileId: String) throws -> [SpaceSuggestion]? {
    let sessions = profile.appendingPathComponent("zen-sessions.jsonlz4")
    if FileManager.default.fileExists(atPath: sessions.path) {
      let found = try parse(Firefox.decompressMozLz4(Data(contentsOf: sessions)), profileId: profileId)
      if let found, !found.isEmpty { return found }
    }
    guard let file = Firefox.sessionFile(profile: profile) else { return nil }
    return try parse(Firefox.decompressMozLz4(Data(contentsOf: file)), profileId: profileId)
  }

  /// The spaces in a zen-sessions document or a session store; nil when it has none (Firefox, or Zen without spaces).
  public static func parse(_ json: Data, profileId: String) throws -> [SpaceSuggestion]? {
    guard let top = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else {
      throw ImportError.unreadable("Zen's session data is malformed")
    }
    // zen-sessions keeps one set; the session store keeps a set per window.
    let windows = (top["windows"] as? [[String: Any]]) ?? [top]
    guard let spaceList = windows.lazy.compactMap({ $0["spaces"] as? [[String: Any]] }).first(where: { !$0.isEmpty }) else { return nil }
    let folders = windows.flatMap { $0["folders"] as? [[String: Any]] ?? [] }
    let tabs = windows.flatMap { $0["tabs"] as? [[String: Any]] ?? [] }

    var spaces: [String: SpaceSuggestion] = [:]
    var order: [String] = []
    var containers: [String: Int] = [:]
    for space in spaceList {
      guard let uuid = space["uuid"] as? String, spaces[uuid] == nil else { continue }
      let icon = space["icon"] as? String
      let colors = gradient(space["theme"])
      spaces[uuid] = SpaceSuggestion(
        id: uuid, name: (space["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Space",
        color: colors.first, colors: colors.isEmpty ? nil : colors, emoji: emoji(icon), icon: nil,
        profileId: profileId, pinned: [], tabs: [], favorites: [])
      order.append(uuid)
      containers[uuid] = (space["containerTabId"] as? NSNumber)?.intValue ?? 0
    }

    // Folders nest by parentId; a tab names its folder by groupId.
    var folderInfo: [String: [String: Any]] = [:]
    for folder in folders { if let id = folder["id"] as? String { folderInfo[id] = folder } }
    func chain(_ id: String) -> [String] {
      var out: [String] = []
      var at: String? = id
      while let current = at, folderInfo[current] != nil, !out.contains(current), out.count < 8 {
        out.insert(current, at: 0)
        at = folderInfo[current]?["parentId"] as? String
      }
      return out
    }

    // Pinned rows per space in Zen's order: a folder takes the place of its first tab.
    var rows: [String: [Row]] = [:]
    var essentials: [(tab: ImportedTab, container: Int)] = []
    for tab in tabs {
      if tab["zenIsEmpty"] as? Bool == true { continue }
      guard let page = Self.page(tab) else { continue }
      let pinned = tab["pinned"] as? Bool ?? false
      let lastActive = (tab["lastAccessed"] as? NSNumber)?.doubleValue
      if tab["zenEssential"] as? Bool == true {
        essentials.append((ImportedTab(url: page.url, title: page.title, pinned: true, lastActive: lastActive),
                           (tab["userContextId"] as? NSNumber)?.intValue ?? 0))
        continue
      }
      let group = tab["groupId"] as? String
      let folderSpace = group.flatMap { folderInfo[$0]?["workspaceId"] as? String }
      guard let space = (tab["zenWorkspace"] as? String).flatMap({ spaces[$0] != nil ? $0 : nil }) ?? folderSpace.flatMap({ spaces[$0] != nil ? $0 : nil }) ?? order.first else { continue }
      if pinned {
        let path = group.map(chain) ?? []
        add(BookmarkNode(type: .url, title: page.title, url: page.url), at: path[...], to: &rows[space, default: []],
            named: { folderInfo[$0]?["name"] as? String ?? "Folder" })
      } else {
        spaces[space]?.tabs.append(ImportedTab(url: page.url, title: page.title, lastActive: lastActive))
      }
    }

    for uuid in order {
      spaces[uuid]?.pinned = (rows[uuid] ?? []).map(\.node)
      spaces[uuid]?.favorites = essentials.filter { $0.container == containers[uuid] }.map(\.tab)
    }
    return order.compactMap { spaces[$0] }
  }

  // A tab's page: where it is, or for one that never loaded (pinned and essential tabs after a restart), where its pin
  // or its typed address points.
  static func page(_ tab: [String: Any]) -> (url: String, title: String)? {
    let entries = tab["entries"] as? [[String: Any]] ?? []
    let index = min(max((tab["index"] as? Int ?? entries.count) - 1, 0), max(entries.count - 1, 0))
    let entry = entries.isEmpty ? nil : entries[index]
    let initial = (tab["_zenPinnedInitialState"] as? [String: Any])?["entry"] as? [String: Any]
    let candidates = [entry?["url"] as? String, initial?["url"] as? String, tab["userTypedValue"] as? String]
    guard let url = candidates.compactMap({ $0 }).first(where: { !$0.isEmpty && $0 != "about:blank" && !$0.hasPrefix("about:newtab") }) else {
      return nil
    }
    let title = [entry?["title"] as? String, initial?["title"] as? String].compactMap { $0 }.first { !$0.isEmpty } ?? ""
    return (url, title)
  }

  static func emoji(_ icon: String?) -> String? {
    guard let icon, !icon.isEmpty, !icon.contains(":"), !icon.contains("/"), icon.count <= 2 else { return nil }
    return icon
  }

  // Zen's gradient: each colour an [r, g, b] in `c`.
  static func gradient(_ theme: Any?) -> [String] {
    let stops = (theme as? [String: Any])?["gradientColors"] as? [[String: Any]] ?? []
    return stops.compactMap { stop in
      if let hex = stop["c"] as? String, hex.hasPrefix("#") { return hex }
      guard let c = stop["c"] as? [NSNumber], c.count >= 3 else { return nil }
      return String(format: "#%02X%02X%02X", c[0].intValue & 255, c[1].intValue & 255, c[2].intValue & 255)
    }
  }

  // A space's pinned rows as they are built: pages, and folders (by Zen's id) that fill as their tabs come.
  indirect enum Row {
    case page(BookmarkNode)
    case folder(id: String, name: String, rows: [Row])

    var node: BookmarkNode {
      switch self {
      case .page(let node): return node
      case .folder(_, let name, let rows): return .folder(name, rows.map(\.node))
      }
    }
  }

  /// Puts `node` in the folder `path` names (outermost first), making the folders it lacks where it is.
  static func add(_ node: BookmarkNode, at path: ArraySlice<String>, to rows: inout [Row], named name: (String) -> String) {
    guard let id = path.first else { return rows.append(.page(node)) }
    let index = rows.firstIndex { if case .folder(id, _, _) = $0 { return true } else { return false } }
    if let index, case .folder(_, let title, var children) = rows[index] {
      add(node, at: path.dropFirst(), to: &children, named: name)
      rows[index] = .folder(id: id, name: title, rows: children)
    } else {
      var children: [Row] = []
      add(node, at: path.dropFirst(), to: &children, named: name)
      rows.append(.folder(id: id, name: name(id), rows: children))
    }
  }
}
