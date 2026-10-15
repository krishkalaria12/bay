import Foundation

public struct ArcSidebar: Equatable {
  public var spaces: [SpaceSuggestion] = []
  public var favorites: [String: [ImportedTab]] = [:]

  public static func parse(_ data: Data) throws -> ArcSidebar {
    guard let top = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let sidebar = top["sidebar"] as? [String: Any],
          let containers = sidebar["containers"] as? [Any] else {
      throw ImportError.unreadable("StorableSidebar.json is not an Arc sidebar")
    }
    guard let box = containers.compactMap({ $0 as? [String: Any] })
      .first(where: { $0["spaces"] != nil || $0["items"] != nil }) else { return ArcSidebar() }

    var items: [String: [String: Any]] = [:]
    for item in objects(box["items"]) {
      if let id = item["id"] as? String { items[id] = item }
    }

    var out = ArcSidebar()
    var untitled = 0
    for space in objects(box["spaces"]) {
      guard let id = space["id"] as? String else { continue }
      let profile = profileDirectory(space["profile"]) ?? "Default"
      let roots = containerIDs(space)
      var seen = Set<String>()
      let pinned = roots["pinned"].map { tree(of: $0, items: items, seen: &seen) } ?? []
      let today = roots["unpinned"].map { flatTabs(of: $0, items: items, seen: &seen, pinned: false) } ?? []
      let info = space["customInfo"] as? [String: Any]
      let icon = info?["iconType"] as? [String: Any]
      let name: String
      if let title = space["title"] as? String, !title.isEmpty {
        name = title
      } else {
        untitled += 1
        name = "Space \(untitled)"
      }
      let theme = info?["windowTheme"]
      out.spaces.append(SpaceSuggestion(
        id: id,
        name: name,
        color: midTone(theme),
        colors: gradient(theme),
        emoji: emoji(icon),
        icon: icon?["icon"] as? String,
        profileId: profile,
        pinned: pinned,
        tabs: today
      ))
    }

    for (descriptor, container) in pairs(box["topAppsContainerIDs"]) {
      guard let profile = profileDirectory(descriptor), let container = container as? String else { continue }
      var seen = Set<String>()
      let tabs = flatTabs(of: container, items: items, seen: &seen, pinned: true)
      if !tabs.isEmpty { out.favorites[profile, default: []] += tabs }
    }
    return out
  }

  // MARK: - Helpers

  static func objects(_ any: Any?) -> [[String: Any]] {
    (any as? [Any] ?? []).compactMap { $0 as? [String: Any] }
  }

  static func pairs(_ any: Any?) -> [(Any, Any)] {
    let list = any as? [Any] ?? []
    return stride(from: 0, to: list.count - 1, by: 2).map { (list[$0], list[$0 + 1]) }
  }

  static func profileDirectory(_ any: Any?) -> String? {
    guard let d = any as? [String: Any] else { return nil }
    if d["default"] != nil { return "Default" }
    guard let custom = (d["custom"] as? [String: Any])?["_0"] as? [String: Any],
          let dir = custom["directoryBasename"] as? String, !dir.isEmpty else { return nil }
    return dir
  }

  static func containerIDs(_ space: [String: Any]) -> [String: String] {
    var out: [String: String] = [:]
    for (label, value) in pairs(space["newContainerIDs"]) {
      guard let id = value as? String else { continue }
      if let d = label as? [String: Any], let key = d.keys.first { out[key] = out[key] ?? id }
    }
    for (label, value) in pairs(space["containerIDs"]) {
      if let key = label as? String, let id = value as? String { out[key] = out[key] ?? id }
    }
    return out
  }

  static func customTitle(_ item: [String: Any]) -> String? {
    (item["title"] as? String).flatMap { $0.isEmpty ? nil : $0 }
  }

  static func tab(_ item: [String: Any], pinned: Bool) -> ImportedTab? {
    guard let tab = (item["data"] as? [String: Any])?["tab"] as? [String: Any],
          let url = tab["savedURL"] as? String, !url.isEmpty else { return nil }
    let last = (tab["timeLastActiveAt"] as? NSNumber).map { ($0.doubleValue + 978_307_200) * 1000 }
    return ImportedTab(url: url, title: tab["savedTitle"] as? String ?? "", pinned: pinned,
                       customTitle: customTitle(item), lastActive: last)
  }

  private enum TreeTask {
    case visit(String, Int)
    case finishFolder(String, Int)
  }

  static func tree(of containerID: String, items: [String: [String: Any]], seen: inout Set<String>) -> [BookmarkNode] {
    guard let container = items[containerID], seen.insert(containerID).inserted else { return [] }
    var out: [BookmarkNode] = []
    var pending = (container["childrenIds"] as? [String] ?? []).reversed().map { TreeTask.visit($0, 0) }
    while let task = pending.popLast() {
      switch task {
      case let .finishFolder(title, start):
        let children = Array(out[start...])
        out.removeSubrange(start...)
        out.append(.folder(title, children))
      case let .visit(id, depth):
        guard let item = items[id], seen.insert(id).inserted else { continue }
        let data = item["data"] as? [String: Any] ?? [:]
        if let t = tab(item, pinned: true) {
          var link = BookmarkNode.link(t.customTitle ?? t.title, t.url)
          if t.customTitle != nil { link.pageTitle = t.title }
          out.append(link)
        } else if data["list"] != nil || data["splitView"] != nil {
          // Keep five folder levels. Overflow folders contribute their tabs to the fifth level.
          // An explicit stack also keeps deeply nested or cyclic source data from losing tabs.
          let folder = data["list"] != nil && depth < 5
          if folder { pending.append(.finishFolder(customTitle(item) ?? "Folder", out.count)) }
          for child in (item["childrenIds"] as? [String] ?? []).reversed() {
            pending.append(.visit(child, depth + (folder ? 1 : 0)))
          }
        }
      }
    }
    return out
  }

  static func flatTabs(of containerID: String, items: [String: [String: Any]], seen: inout Set<String>, pinned: Bool) -> [ImportedTab] {
    guard let container = items[containerID], seen.insert(containerID).inserted else { return [] }
    var out: [ImportedTab] = []
    var pending = Array((container["childrenIds"] as? [String] ?? []).reversed())
    while let id = pending.popLast() {
      guard let item = items[id], seen.insert(id).inserted else { continue }
      if let t = tab(item, pinned: pinned) {
        out.append(t)
      } else {
        pending.append(contentsOf: (item["childrenIds"] as? [String] ?? []).reversed())
      }
    }
    return out
  }

  static func emoji(_ icon: [String: Any]?) -> String? {
    if let e = icon?["emoji_v2"] as? String, !e.isEmpty { return e }
    if let e = icon?["emoji"] as? String, !e.isEmpty { return e }
    if let n = icon?["emoji"] as? Int, let scalar = Unicode.Scalar(n) { return String(Character(scalar)) }
    return nil
  }

  static func color(_ any: Any?) -> String? {
    guard let c = any as? [String: Any], let r = c["red"] as? Double, let g = c["green"] as? Double,
          let b = c["blue"] as? Double else { return nil }
    return Hex.color(red: r, green: g, blue: b)
  }

  static func midTone(_ theme: Any?) -> String? {
    if let palette = (theme as? [String: Any])?["primaryColorPalette"] as? [String: Any], let c = color(palette["midTone"]) {
      return c
    }
    return firstColor(theme, depth: 0)
  }

  private static func firstColor(_ any: Any?, depth: Int) -> String? {
    guard depth < 12 else { return nil }
    if let c = color(any) { return c }
    if let d = any as? [String: Any] {
      for key in d.keys.sorted() { if let c = firstColor(d[key], depth: depth + 1) { return c } }
    } else if let a = any as? [Any] {
      for v in a { if let c = firstColor(v, depth: depth + 1) { return c } }
    }
    return nil
  }

  static func gradient(_ theme: Any?) -> [String]? {
    func find(_ any: Any?, _ depth: Int) -> [Any]? {
      guard depth < 12 else { return nil }
      if let d = any as? [String: Any] {
        if let base = d["baseColors"] as? [Any] { return base }
        for key in d.keys.sorted() { if let r = find(d[key], depth + 1) { return r } }
      } else if let a = any as? [Any] {
        for v in a { if let r = find(v, depth + 1) { return r } }
      }
      return nil
    }
    let colors = (find(theme, 0) ?? []).compactMap { entry -> String? in
      color(entry) ?? firstColor(entry, depth: 0)
    }
    return colors.isEmpty ? nil : colors
  }
}
