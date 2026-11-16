import AppKit

enum AppIcons {
  // The icons people can pick in Settings › Appearance. "default" is the bundle's own icon (Dusk in Paper);
  // the others are drawn artwork in the asset catalog, named AppIcon<name> (scripts/make-icon.sh renders them).
  struct Variant {
    let id: String
    let name: String
  }

  static let defaultsKey = "NNAppIcon"
  static func changedNotification(bundleId: String) -> Notification.Name { .init("\(bundleId).AppIconChanged") }

  static let variants: [Variant] = [
    Variant(id: "default", name: "Paper"),
    Variant(id: "navy", name: "Navy"),
    Variant(id: "coral", name: "Coral"),
    Variant(id: "noir", name: "Noir"),
    Variant(id: "cobalt", name: "Cobalt"),
    Variant(id: "bridge", name: "Bridge"),
  ]

  static var current: String {
    let id = UserDefaults.standard.string(forKey: defaultsKey) ?? "default"
    return variants.contains { $0.id == id } ? id : "default"
  }

  static func restore() {
    if current != "default" { apply(current) }
  }

  // `announce` tells the Dock tile plug-in, which serves every copy with this bundle id (the installed app's too).
  static func set(_ id: String, announce: Bool) {
    guard variants.contains(where: { $0.id == id }) else { return }
    UserDefaults.standard.set(id, forKey: defaultsKey)
    apply(id)
    if announce, let bundleId = Bundle.main.bundleIdentifier {
      DistributedNotificationCenter.default().postNotificationName(
        changedNotification(bundleId: bundleId), object: nil, userInfo: ["icon": id], deliverImmediately: true)
    }
  }

  private static func apply(_ id: String) {
    NSApp.applicationIconImage = id == "default" ? nil : image(id, size: 512)
  }

  private static var cache: [String: NSImage] = [:]

  // The app whose artwork is drawn: this one, or for the Dock tile plug-in, the app that holds it.
  static var bundle: Bundle = .main {
    didSet { cache.removeAll() }
  }

  static var base: NSImage = NSImage(named: "AppIcon") ?? NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath) {
    didSet { cache.removeAll() }
  }

  static func image(_ id: String, size: CGFloat) -> NSImage? {
    let key = "\(id)@\(size)"
    if let hit = cache[key] { return hit }
    guard let variant = variants.first(where: { $0.id == id }) else { return nil }
    let artwork = id == "default" ? base : bundle.image(forResource: "AppIcon\(variant.name)")
    guard let artwork else { return nil }
    let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
      artwork.draw(in: rect)
      return true
    }
    cache[key] = image
    return image
  }

  static func preview(_ id: String, size: CGFloat) -> String? {
    guard let image = image(id, size: size * 2),
          let tiff = image.tiffRepresentation,
          let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return nil }
    return "data:image/png;base64,\(png.base64EncodedString())"
  }
}

enum DockTile {
  private static let domain = "com.apple.dock" as CFString
  private static let key = "persistent-apps" as CFString

  private static var tiles: [[String: Any]] {
    CFPreferencesCopyAppValue(key, domain) as? [[String: Any]] ?? []
  }

  static var isInDock: Bool {
    let bundleId = Bundle.main.bundleIdentifier
    let path = Bundle.main.bundleURL.standardizedFileURL.path
    return tiles.contains { tile in
      let data = tile["tile-data"] as? [String: Any]
      if let id = data?["bundle-identifier"] as? String, id == bundleId { return true }
      let file = (data?["file-data"] as? [String: Any])?["_CFURLString"] as? String
      return file.flatMap(URL.init(string:))?.standardizedFileURL.path == path
    }
  }

  @discardableResult
  static func add() -> Bool {
    guard !isInDock else { return true }
    let tile: [String: Any] = [
      "tile-type": "file-tile",
      "tile-data": [
        "bundle-identifier": Bundle.main.bundleIdentifier ?? "",
        "file-label": ProcessInfo.processInfo.processName,
        "file-type": 41,
        "file-data": ["_CFURLString": Bundle.main.bundleURL.absoluteString, "_CFURLStringType": 15],
      ] as [String: Any],
    ]
    CFPreferencesSetAppValue(key, (tiles + [tile]) as CFArray, domain)
    guard CFPreferencesAppSynchronize(domain) else { return false }
    // Dock reads persistent-apps only at startup.
    let restart = Process()
    restart.executableURL = URL(fileURLWithPath: "/usr/bin/killall")
    restart.arguments = ["Dock"]
    try? restart.run()
    return true
  }
}
