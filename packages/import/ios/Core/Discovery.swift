import Foundation

public struct BrowserDefinition: Sendable {
  public enum Family: String, Codable, Sendable {
    case chromium, firefox, safari, arc
    case automation
  }

  public var id: String
  public var name: String
  public var family: Family
  public var bundleIds: [String]
  public var dataPath: String?
  public var keychainService: String?
  public var keychainAccount: String?
  public var rootIsProfile = false

  public static let all: [BrowserDefinition] = [
    chromium("chrome", "Google Chrome", ["com.google.Chrome"], "Google/Chrome", "Chrome"),
    arc,
    dia,
    .init(id: "safari", name: "Safari", family: .safari, bundleIds: ["com.apple.Safari"]),
    .init(id: "firefox", name: "Firefox", family: .firefox, bundleIds: ["org.mozilla.firefox"], dataPath: "Firefox"),
    .init(id: "zen", name: "Zen", family: .firefox, bundleIds: ["app.zen-browser.zen"], dataPath: "zen"),
    chromium("edge", "Microsoft Edge", ["com.microsoft.edgemac"], "Microsoft Edge", "Microsoft Edge"),
    chromium("brave", "Brave", ["com.brave.Browser"], "BraveSoftware/Brave-Browser", "Brave"),
    BrowserDefinition(id: "helium", name: "Helium", family: .chromium, bundleIds: ["net.imput.helium"],
                      dataPath: "net.imput.helium", keychainService: "Helium Storage Key", keychainAccount: "Helium"),
    chromium("opera", "Opera", ["com.operasoftware.Opera"], "com.operasoftware.Opera", "Opera", rootIsProfile: true),
    chromium("operaGX", "Opera GX", ["com.operasoftware.OperaGX"], "com.operasoftware.OperaGX", "Opera", rootIsProfile: true),
    chromium("vivaldi", "Vivaldi", ["com.vivaldi.Vivaldi"], "Vivaldi", "Vivaldi"),
    chromium("island", "Island", ["io.island.Island", "com.island.Island"], "Island", "Island"),
    chromium("chromeBeta", "Google Chrome Beta", ["com.google.Chrome.beta"], "Google/Chrome Beta", "Chrome"),
    chromium("chromeDev", "Google Chrome Dev", ["com.google.Chrome.dev"], "Google/Chrome Dev", "Chrome"),
    chromium("chromeCanary", "Google Chrome Canary", ["com.google.Chrome.canary"], "Google/Chrome Canary", "Chrome"),
    chromium("chromium", "Chromium", ["org.chromium.Chromium"], "Chromium", "Chromium"),
  ]

  static let arc = BrowserDefinition(id: "arc", name: "Arc", family: .arc, bundleIds: ["company.thebrowser.Browser"],
                                     dataPath: "Arc/User Data", keychainService: "Arc Safe Storage", keychainAccount: "Arc")

  static let dia = BrowserDefinition(id: "dia", name: "Dia", family: .chromium, bundleIds: ["company.thebrowser.dia"],
                                     dataPath: "Dia/User Data", keychainService: "Dia Safe Storage", keychainAccount: "Dia")

  public static let diaTabsId = "diaTabs"

  static func chromium(_ id: String, _ name: String, _ bundleIds: [String], _ path: String, _ keychain: String,
                       rootIsProfile: Bool = false) -> BrowserDefinition {
    BrowserDefinition(id: id, name: name, family: .chromium, bundleIds: bundleIds, dataPath: path,
                      keychainService: "\(keychain) Safe Storage", keychainAccount: keychain, rootIsProfile: rootIsProfile)
  }

  public static func find(_ id: String) -> BrowserDefinition? { all.first { $0.id == id } }

  public var isChromiumBased: Bool { family == .chromium || family == .arc }
}

public struct SpaceSummary: Codable, Equatable, Sendable {
  public var id: String
  public var name: String
  public var color: String?
  public var emoji: String?
  public var icon: String?
  public var pinnedCount: Int
  public var tabCount: Int
}

public struct BrowserProfile: Codable, Equatable, Sendable {
  public var id: String
  public var name: String
  public var path: String
  public var email: String?
  public var avatarPath: String?
  public var color: String?
  public var isDefault: Bool
  public var available: [ImportKind]
  public var spaces: [SpaceSummary]?
}

public struct BrowserSource: Codable, Equatable, Sendable {
  public var id: String
  public var name: String
  public var family: BrowserDefinition.Family
  public var appPath: String?
  public var iconPath: String?
  public var requiresExport: Bool
  public var needsKeychain: Bool
  public var needsFullDiskAccess = false
  public var profiles: [BrowserProfile]
}

public struct BrowserApplication: Codable, Equatable, Sendable {
  public var id: String
  public var name: String
  public var appPath: String
  public var iconPath: String?
}

public struct BrowserDiscovery {
  public var applicationSupport: URL
  public var locateApp: ([String]) -> URL?
  public var iconFor: (URL, String) -> String?

  public init(applicationSupport: URL, locateApp: @escaping ([String]) -> URL? = { _ in nil },
              iconFor: @escaping (URL, String) -> String? = { _, _ in nil }) {
    self.applicationSupport = applicationSupport
    self.locateApp = locateApp
    self.iconFor = iconFor
  }

  public func list() -> [BrowserSource] {
    var out = BrowserDefinition.all.compactMap(source)
    if let tabs = diaTabsSource() {
      out.insert(tabs, at: out.firstIndex { $0.id == "dia" }.map { $0 + 1 } ?? out.count)
    }
    return out
  }

  // Onboarding shows installed apps even when they have no importable profiles yet.
  public func installedApplications() -> [BrowserApplication] {
    BrowserDefinition.all.compactMap { def in
      guard let app = locateApp(def.bundleIds) else { return nil }
      return BrowserApplication(id: def.id, name: def.name, appPath: app.path, iconPath: iconFor(app, def.id))
    }
  }

  func diaTabsSource() -> BrowserSource? {
    guard let app = locateApp(BrowserDefinition.dia.bundleIds) else { return nil }
    return BrowserSource(id: BrowserDefinition.diaTabsId, name: "Dia: open and pinned tabs (via Dia)", family: .automation,
                         appPath: app.path, iconPath: iconFor(app, BrowserDefinition.dia.id), requiresExport: false,
                         needsKeychain: false, profiles: [])
  }

  public func source(_ def: BrowserDefinition) -> BrowserSource? {
    let app = locateApp(def.bundleIds)
    var profiles: [BrowserProfile] = []
    switch def.family {
    case .safari:
      guard app != nil else { return nil }
    case .firefox:
      profiles = firefoxProfiles(def)
    case .chromium, .arc:
      profiles = chromiumProfiles(def)
    case .automation:
      return nil
    }
    let denied = def.family != .safari && profiles.isEmpty && dataDirectory(def).map { root in
      Self.isAccessDenied(root) && ["Local State", "Default", "profiles.ini"].contains {
        FileManager.default.fileExists(atPath: root.appendingPathComponent($0).path)
      }
    } == true
    guard def.family == .safari || !profiles.isEmpty || denied else { return nil }
    return BrowserSource(
      id: def.id, name: def.name, family: def.family, appPath: app?.path,
      iconPath: app.flatMap { iconFor($0, def.id) },
      requiresExport: def.family == .safari, needsKeychain: def.isChromiumBased,
      needsFullDiskAccess: denied, profiles: profiles
    )
  }

  static func isAccessDenied(_ dir: URL) -> Bool {
    guard FileManager.default.fileExists(atPath: dir.path) else { return false }
    do {
      _ = try FileManager.default.contentsOfDirectory(atPath: dir.path)
      return false
    } catch let error as NSError {
      if error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoPermissionError { return true }
      let posix = (error.userInfo[NSUnderlyingErrorKey] as? NSError)
      return posix?.domain == NSPOSIXErrorDomain && (posix?.code == Int(EPERM) || posix?.code == Int(EACCES))
    }
  }

  public func dataDirectory(_ def: BrowserDefinition) -> URL? {
    def.dataPath.map { applicationSupport.appendingPathComponent($0, isDirectory: true) }
  }

  public func profileDirectory(_ def: BrowserDefinition, _ profileId: String) throws -> URL {
    guard let root = dataDirectory(def) else { throw ImportError.unsupported("\(def.name) has no profiles on disk") }
    let dir = root.appendingPathComponent(profileId, isDirectory: true).standardizedFileURL
    let rootPath = root.standardizedFileURL.path
    guard dir.path == rootPath || dir.path.hasPrefix(rootPath + "/") else { throw ImportError.notFound("Unknown profile") }
    guard FileManager.default.fileExists(atPath: dir.path) else { throw ImportError.notFound("Profile \(profileId) not found") }
    return dir
  }

  // MARK: Profiles

  /// The profiles in a browser's data folder, from the shared reader (bay-import's discovery, as Windows and Linux
  /// list them). A data folder that is a profile (Opera) is ".".
  func sharedProfiles(_ def: BrowserDefinition, root: URL) -> [BrowserProfile] {
    var request: [String: Any] = ["reader": "profiles", "root": root.path, "firefox": def.family == .firefox,
                                  "rootIsProfile": def.rootIsProfile, "rootId": ".", "chromiumCookies": true]
    if def.family == .arc { request["arcSidebar"] = arcSidebarURL().path }
    return (try? SharedReaders.read(request, as: [BrowserProfile].self)) ?? []
  }

  // MARK: Chromium

  func chromiumProfiles(_ def: BrowserDefinition) -> [BrowserProfile] {
    guard let root = dataDirectory(def) else { return [] }
    let fm = FileManager.default
    return sharedProfiles(def, root: root).map { shared in
      var profile = shared
      let path = URL(fileURLWithPath: profile.path, isDirectory: true)
      let picture = path.appendingPathComponent("Google Profile Picture.png")
      if fm.fileExists(atPath: picture.path) { profile.avatarPath = picture.path }
      if !ChromiumExtensions.list(profile: path).isEmpty { profile.available.append(.extensions) }
      return profile
    }
  }

  // MARK: Arc

  public func arcSidebarURL() -> URL {
    applicationSupport.appendingPathComponent("Arc/StorableSidebar.json")
  }

  // MARK: Firefox

  /// Firefox profiles in the data folder, by their path there (an import names one that way).
  func firefoxProfiles(_ def: BrowserDefinition) -> [BrowserProfile] {
    guard let root = dataDirectory(def) else { return [] }
    // The shared reader gives canonical paths (realpath's; resolvingSymlinksInPath drops /private instead).
    let canonical = realpath(root.path, nil).map { pointer in
      defer { free(pointer) }
      return String(cString: pointer)
    }
    let base = (canonical ?? root.path) + "/"
    return sharedProfiles(def, root: root).compactMap { shared in
      guard shared.path.hasPrefix(base) else { return nil }
      var profile = shared
      profile.id = String(shared.path.dropFirst(base.count))
      if FirefoxExtensions.hasAddons(profile: URL(fileURLWithPath: shared.path)) { profile.available.append(.extensions) }
      return profile
    }
  }
}
