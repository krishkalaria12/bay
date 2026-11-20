import BayAdblock
import ExpoModulesCore
import Foundation
import QuartzCore
import WebKit

private final class ContentBlockingException: GenericException<String>, @unchecked Sendable {
  override var reason: String { "Couldn't prepare the content blocker: \(param)" }
}

/// Filter lists, converted by the Rust blocker into WebKit content-blocking rules and compiled once per list version.
/// Compiled lists are cached by WebKit's rule list store, so a relaunch only looks them up.
final class BayContentBlocker {
  static let shared = BayContentBlocker()

  // WebKit rejects a rule list above roughly 150,000 rules; smaller lists also compile faster.
  private static let rulesPerList = 50_000
  private static let identifierPrefix = "bay-blocker-"
  /// Each group's compiled lists (C3): "ads", "trackers", "cookies", or "all" when the lists came without groups.
  private var ruleLists: [String: [WKContentRuleList]] = [:]
  private var pausedHosts: Set<String> = []
  /// The groups each site turns off (C3), by host; a host covers its subdomains.
  private var siteGroupsOff: [String: Set<String>] = [:]
  private let views = NSHashTable<BayEngineView>.weakObjects()
  private var generation = 0
  /// adblock-rust engine for scriptlets (`##+js`), which content rules can't express. Used on the main thread only.
  private var engine: OpaquePointer?
  private var engineGeneration = 0

  func register(_ view: BayEngineView) {
    views.add(view)
    view.applyContentRules(for: view.webView.url)
  }

  func rules(for url: URL?) -> [WKContentRuleList] {
    guard let url else { return ruleLists.values.flatMap { $0 } }
    guard let host = url.host?.lowercased(), !isPaused(host) else { return [] }
    let off = groupsOff(host)
    return ruleLists.filter { !off.contains($0.key) }.flatMap { $0.value }
  }

  /// The groups each site turns off (C3), as `{ host: [group] }` JSON.
  func setSiteGroups(_ json: String) {
    let parsed = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: [String]] ?? [:]
    siteGroupsOff = parsed.reduce(into: [:]) { result, entry in result[entry.key.lowercased()] = Set(entry.value) }
    loadGroupEnginesIfNeeded()
    refreshViews()
  }

  private func groupsOff(_ host: String) -> Set<String> {
    siteGroupsOff.reduce(into: Set<String>()) { result, entry in
      if host == entry.key || host.hasSuffix(".\(entry.key)") { result.formUnion(entry.value) }
    }
  }

  func setPausedHosts(_ hosts: [String]) {
    pausedHosts = Set(hosts.map { $0.lowercased() })
    refreshViews()
  }

  private func isPaused(_ host: String) -> Bool {
    pausedHosts.contains { host == $0 || host.hasSuffix(".\($0)") }
  }

  /// Applies the filter lists to every page view; `nil` turns blocking off. Each group's reader returns its lists'
  /// text, and runs off the main thread only when this `version` of that group isn't compiled yet; groups compile one
  /// after another, each into rule lists of its own, so a site can leave one out (C3). Resolves with the rule count.
  func apply(groups: [String: () -> String?]?, version: String, completion: @escaping (Result<Int, Error>) -> Void) {
    generation += 1
    let generation = generation
    let started = CACurrentMediaTime()
    guard let groups, !groups.isEmpty else {
      ruleLists = [:]
      refreshViews()
      completion(.success(0))
      return
    }
    let store = WKContentRuleListStore.default()!
    let versionPrefix = "\(Self.identifierPrefix)\(Self.safe(version))-"
    let names = groups.keys.sorted()
    var compiled: [String: [WKContentRuleList]] = [:]
    var total = 0

    func next(_ index: Int) {
      guard generation == self.generation else { return }
      guard index < names.count else {
        NSLog("BayContentBlocker: %d rules ready in %.0f ms", total, (CACurrentMediaTime() - started) * 1000)
        ruleLists = compiled
        refreshViews()
        Self.removeStale(except: versionPrefix, store: store)
        completion(.success(total))
        return
      }
      let name = names[index]
      let prefix = "\(versionPrefix)\(name)-"
      Self.applyGroup(read: groups[name]!, prefix: prefix, store: store) { [weak self] result in
        DispatchQueue.main.async {
          guard let self, generation == self.generation else { return }
          switch result {
          case .success(let (lists, count)):
            compiled[name] = lists
            total += count
            next(index + 1)
          case .failure(let error):
            completion(.failure(error))
          }
        }
      }
    }

    next(0)
  }

  /// One group's rule lists: looked up when this version was compiled before, compiled otherwise.
  private static func applyGroup(read: @escaping () -> String?, prefix: String, store: WKContentRuleListStore,
                                 finish: @escaping (Result<([WKContentRuleList], Int), Error>) -> Void) {
    let countKey = "bay.contentBlocker.\(prefix)"
    let cached = UserDefaults.standard.integer(forKey: countKey)
    let cachedRules = UserDefaults.standard.integer(forKey: countKey + ".rules")
    guard cached > 0 else {
      compile(lists: read, prefix: prefix, store: store, countKey: countKey, finish: finish)
      return
    }
    lookUp(prefix: prefix, count: cached, store: store) { found in
      if let found {
        finish(.success((found, cachedRules)))
      } else {
        compile(lists: read, prefix: prefix, store: store, countKey: countKey, finish: finish)
      }
    }
  }

  /// Loads the engine from its cache (or builds and caches it) off the main thread, with the bundled scriptlet
  /// resources; `nil` unloads it. `groups` names each path's group (C3), as `setContentBlocking` passes them: once a
  /// site turns a group off, an engine per group loads too, so that site's scriptlets and blocked count (C20) leave
  /// that group out. Every other site keeps the one engine of all the lists, whose exceptions reach across lists.
  func loadScriptletEngine(paths: [String]?, groups: [String]?, version: String) {
    engineGeneration += 1
    let generation = engineGeneration
    replaceGroupEngines([:])
    guard let paths, !paths.isEmpty else {
      engineSource = nil
      replaceEngine(nil)
      return
    }
    engineSource = EngineSource(paths: paths, groups: groups?.count == paths.count ? groups : nil, version: version)
    Self.loadEngine(paths: paths, name: "engine", version: version) { [weak self] loaded in
      guard let self, generation == self.engineGeneration else {
        if let loaded { bay_blocker_free(loaded) }
        return
      }
      self.replaceEngine(loaded)
      self.loadGroupEnginesIfNeeded()
    }
  }

  /// What the engines were last loaded from, so the group engines can follow when a site first turns a group off.
  private struct EngineSource {
    let paths: [String]
    let groups: [String]?
    let version: String
  }

  private var engineSource: EngineSource?
  /// One engine per group (C20), each with the "shared" lists too; empty until a site turns a group off.
  private var groupEngines: [String: OpaquePointer] = [:]
  private var loadingGroupEngines = false

  /// Loads the group engines the first time a site turns a group off; they stay until the lists change.
  private func loadGroupEnginesIfNeeded() {
    guard !siteGroupsOff.isEmpty, groupEngines.isEmpty, !loadingGroupEngines, engine != nil, let source = engineSource,
          let groups = source.groups else { return }
    let pairs = Array(zip(source.paths, groups))
    let shared = pairs.filter { $0.1 == "shared" }.map(\.0)
    let names = Set(groups).subtracting(["shared"]).sorted()
    guard !names.isEmpty else { return }
    loadingGroupEngines = true
    let generation = engineGeneration
    var loaded: [String: OpaquePointer] = [:]
    func next(_ index: Int) {
      guard index < names.count else {
        loadingGroupEngines = false
        guard generation == engineGeneration else {
          loaded.values.forEach { bay_blocker_free($0) }
          return
        }
        replaceGroupEngines(loaded)
        return
      }
      let name = names[index]
      Self.loadEngine(paths: pairs.filter { $0.1 == name }.map(\.0) + shared, name: "engine-\(name)", version: source.version) { engine in
        if let engine { loaded[name] = engine }
        next(index + 1)
      }
    }
    next(0)
  }

  /// One engine from its cache, or built and cached, off the main thread; `done` runs on the main thread.
  private static func loadEngine(paths: [String], name: String, version: String, done: @escaping (OpaquePointer?) -> Void) {
    DispatchQueue.global(qos: .utility).async {
      let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("bay-adblock")
      try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let cache = directory.appendingPathComponent("\(name).bin").path
      let resources = Bundle.main.path(forResource: "bay-adblock-resources", ofType: "json")
      let started = CACurrentMediaTime()
      let files = paths.map { strdup($0) }
      defer { files.forEach { free($0) } }
      let loaded = files.map { UnsafePointer<CChar>($0) }.withUnsafeBufferPointer { buffer in
        bay_blocker_load(buffer.baseAddress, buffer.count, cache, version, resources, 2)
      }
      NSLog("BayContentBlocker: %@ ready in %.0f ms", name, (CACurrentMediaTime() - started) * 1000)
      DispatchQueue.main.async { done(loaded) }
    }
  }

  private func replaceEngine(_ next: OpaquePointer?) {
    if let engine { bay_blocker_free(engine) }
    engine = next
  }

  private func replaceGroupEngines(_ next: [String: OpaquePointer]) {
    groupEngines.values.forEach { bay_blocker_free($0) }
    groupEngines = next
  }

  /// The engines that apply on a site: none while blocking is paused there, the groups it keeps once it turns some
  /// off, and the engine of every list otherwise. While the group engines load, a site that turned ads off gets
  /// no scriptlets, and its count still checks every list.
  private func engines(for host: String, scriptlets: Bool) -> [OpaquePointer] {
    guard let engine, !isPaused(host) else { return [] }
    let off = groupsOff(host)
    if off.isEmpty { return [engine] }
    if !groupEngines.isEmpty { return groupEngines.filter { !off.contains($0.key) }.map(\.value) }
    return scriptlets && off.contains("ads") ? [] : [engine]
  }

  /// Whether the filter lists stop a request of `type` (an adblock resource type) to `url` from the page at `source`
  /// (C2): how a failed load on the page is told apart from one the blocker stopped. Only the groups the page's site
  /// keeps count (C20). False while the engine is loading.
  func blocks(_ url: String, source: String, type: String) -> Bool {
    guard let host = URL(string: source)?.host?.lowercased() else { return false }
    return engines(for: host, scriptlets: false).contains { engine in
      url.withCString { address in
        source.withCString { page in
          type.withCString { kind in "GET".withCString { bay_blocker_should_block(engine, address, page, kind, $0) } }
        }
      }
    }
  }

  /// Whether the lists are in force on a page at `url`: blocking is on, and not paused for its site.
  func isBlocking(_ url: URL?) -> Bool {
    guard let url else { return false }
    return !rules(for: url).isEmpty
  }

  /// The scriptlets for a page, or nil when it has none or blocking is paused there.
  func scriptlets(for url: URL) -> String? {
    guard let host = url.host?.lowercased() else { return nil }
    let scripts = engines(for: host, scriptlets: true).compactMap { engine -> String? in
      guard let pointer = url.absoluteString.withCString({ bay_blocker_scriptlets(engine, $0) }) else { return nil }
      defer { bay_string_free(pointer) }
      let script = String(cString: pointer)
      return script.isEmpty ? nil : script
    }
    // Every group engine has the shared lists, so on a site whose scriptlets all come from those, each engine returns
    // the same script: it runs once.
    var seen = Set<String>()
    let unique = scripts.filter { seen.insert($0).inserted }
    return unique.isEmpty ? nil : unique.joined(separator: "\n")
  }

  private func refreshViews() {
    for view in views.allObjects { view.applyContentRules(for: view.webView.url) }
  }

  private static func safe(_ version: String) -> String {
    String(version.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || $0 == "-" }.prefix(48))
  }

  private static func lookUp(prefix: String, count: Int, store: WKContentRuleListStore, completion: @escaping ([WKContentRuleList]?) -> Void) {
    var found: [WKContentRuleList?] = Array(repeating: nil, count: count)
    let group = DispatchGroup()
    for index in 0..<count {
      group.enter()
      store.lookUpContentRuleList(forIdentifier: "\(prefix)\(index)") { list, _ in
        DispatchQueue.main.async {
          found[index] = list
          group.leave()
        }
      }
    }
    group.notify(queue: .main) {
      let lists = found.compactMap { $0 }
      completion(lists.count == count ? lists : nil)
    }
  }

  private static func compile(lists: @escaping () -> String?, prefix: String, store: WKContentRuleListStore, countKey: String,
                              finish: @escaping (Result<([WKContentRuleList], Int), Error>) -> Void) {
    DispatchQueue.global(qos: .utility).async {
      guard let text = lists(), !text.isEmpty else {
        finish(.failure(ContentBlockingException("the filter lists couldn't be read")))
        return
      }
      guard let pointer = text.withCString({ bay_content_blocking_rules($0) }) else {
        finish(.failure(ContentBlockingException("the filter lists couldn't be converted")))
        return
      }
      let json = String(cString: pointer)
      bay_string_free(pointer)
      guard let rules = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [Any] else {
        finish(.failure(ContentBlockingException("the converted rules couldn't be read")))
        return
      }
      let chunks = stride(from: 0, to: rules.count, by: rulesPerList).map { Array(rules[$0..<min($0 + rulesPerList, rules.count)]) }
      DispatchQueue.main.async {
        compileChunks(chunks, index: 0, prefix: prefix, store: store, compiled: []) { result in
          if case .success(let compiled) = result {
            UserDefaults.standard.set(compiled.count, forKey: countKey)
            UserDefaults.standard.set(rules.count, forKey: countKey + ".rules")
          }
          finish(result.map { ($0, rules.count) })
        }
      }
    }
  }

  private static func compileChunks(_ chunks: [[Any]], index: Int, prefix: String, store: WKContentRuleListStore, compiled: [WKContentRuleList],
                                    completion: @escaping (Result<[WKContentRuleList], Error>) -> Void) {
    guard index < chunks.count else {
      completion(.success(compiled))
      return
    }
    guard let data = try? JSONSerialization.data(withJSONObject: chunks[index]), let encoded = String(data: data, encoding: .utf8) else {
      completion(.failure(ContentBlockingException("a rule chunk couldn't be encoded")))
      return
    }
    store.compileContentRuleList(forIdentifier: "\(prefix)\(index)", encodedContentRuleList: encoded) { list, error in
      if let error {
        completion(.failure(error))
      } else if let list {
        compileChunks(chunks, index: index + 1, prefix: prefix, store: store, compiled: compiled + [list], completion: completion)
      } else {
        completion(.failure(ContentBlockingException("WebKit returned no rule list")))
      }
    }
  }

  private static func removeStale(except prefix: String, store: WKContentRuleListStore) {
    store.getAvailableContentRuleListIdentifiers { identifiers in
      for identifier in identifiers ?? [] where identifier.hasPrefix(identifierPrefix) && !identifier.hasPrefix(prefix) {
        store.removeContentRuleList(forIdentifier: identifier) { _ in }
      }
    }
  }
}

/// Tracking-parameter stripping for main-frame navigations, shared with Android through the Rust blocker.
enum BayTracking {
  static func setParameters(_ json: String) -> Bool {
    json.withCString { bay_tracking_set($0) }
  }

  static func clean(_ url: URL) -> URL? {
    guard let pointer = url.absoluteString.withCString({ bay_tracking_clean($0) }) else { return nil }
    defer { bay_string_free(pointer) }
    return URL(string: String(cString: pointer))
  }
}

/// Private tabs share one non-persistent data store. The app holds it while any private tab exists
/// (`setPrivateSessionActive`), mounted or not, since only a few page views stay live; once the last private tab
/// closes and its views go, the store goes with its cookies and storage, and the next private tab starts fresh.
enum BayPrivateBrowsing {
  private static weak var current: WKWebsiteDataStore?
  private static var retained: WKWebsiteDataStore?
  private static var active = false

  static func dataStore() -> WKWebsiteDataStore {
    if let current { return current }
    let store = WKWebsiteDataStore.nonPersistent()
    current = store
    if active { retained = store }
    return store
  }

  /// False means no private tab is left: the session is over, so the next private tab gets a new store even if a
  /// closing page still holds this one for a moment.
  static func setActive(_ value: Bool) {
    active = value
    retained = value ? current : nil
    if !value { current = nil }
  }
}

/// Hosts that failed over HTTPS this session, so they load over HTTP without another attempt.
enum BayHTTPS {
  static var httpOnlyHosts = Set<String>()

  static func isLocal(_ host: String) -> Bool {
    host == "localhost" || host.hasPrefix("[") || host.range(of: #"^(\d{1,3}\.){3}\d{1,3}$"#, options: .regularExpression) != nil
      || [".local", ".localhost", ".test", ".internal", ".lan", ".home.arpa"].contains { host.hasSuffix($0) }
  }
}
