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
  private var ruleLists: [WKContentRuleList] = []
  private var pausedHosts: Set<String> = []
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
    guard let host = url?.host?.lowercased(), !isPaused(host) else { return url == nil ? ruleLists : [] }
    return ruleLists
  }

  func setPausedHosts(_ hosts: [String]) {
    pausedHosts = Set(hosts.map { $0.lowercased() })
    refreshViews()
  }

  private func isPaused(_ host: String) -> Bool {
    pausedHosts.contains { host == $0 || host.hasSuffix(".\($0)") }
  }

  /// Applies the filter lists to every page view; `nil` turns blocking off. `lists` reads their text, and runs off the
  /// main thread only when this `version` isn't compiled yet. Resolves with the rule count.
  func apply(lists: (() -> String?)?, version: String, completion: @escaping (Result<Int, Error>) -> Void) {
    generation += 1
    let generation = generation
    let started = CACurrentMediaTime()
    guard let lists else {
      ruleLists = []
      refreshViews()
      completion(.success(0))
      return
    }
    let store = WKContentRuleListStore.default()!
    let prefix = "\(Self.identifierPrefix)\(Self.safe(version))-"
    let countKey = "bay.contentBlocker.\(prefix)"
    let finish: (Result<([WKContentRuleList], Int), Error>) -> Void = { [weak self] result in
      DispatchQueue.main.async {
        guard let self, generation == self.generation else { return }
        switch result {
        case .success(let (compiled, count)):
          NSLog("BayContentBlocker: %d rules ready in %.0f ms", count, (CACurrentMediaTime() - started) * 1000)
          self.ruleLists = compiled
          self.refreshViews()
          Self.removeStale(except: prefix, store: store)
          completion(.success(count))
        case .failure(let error):
          completion(.failure(error))
        }
      }
    }

    let cached = UserDefaults.standard.integer(forKey: countKey)
    let cachedRules = UserDefaults.standard.integer(forKey: countKey + ".rules")
    if cached > 0 {
      Self.lookUp(prefix: prefix, count: cached, store: store) { found in
        if let found {
          finish(.success((found, cachedRules)))
        } else {
          Self.compile(lists: lists, prefix: prefix, store: store, countKey: countKey, finish: finish)
        }
      }
    } else {
      Self.compile(lists: lists, prefix: prefix, store: store, countKey: countKey, finish: finish)
    }
  }

  /// Loads the engine from its cache (or builds and caches it) off the main thread, with the bundled scriptlet
  /// resources; `nil` unloads it.
  func loadScriptletEngine(paths: [String]?, version: String) {
    engineGeneration += 1
    let generation = engineGeneration
    guard let paths, !paths.isEmpty else {
      replaceEngine(nil)
      return
    }
    DispatchQueue.global(qos: .utility).async {
      let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("bay-adblock")
      try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let cache = directory.appendingPathComponent("engine.bin").path
      let resources = Bundle.main.path(forResource: "bay-adblock-resources", ofType: "json")
      let started = CACurrentMediaTime()
      let files = paths.map { strdup($0) }
      defer { files.forEach { free($0) } }
      let loaded = files.map { UnsafePointer<CChar>($0) }.withUnsafeBufferPointer { buffer in
        bay_blocker_load(buffer.baseAddress, buffer.count, cache, version, resources, 2)
      }
      NSLog("BayContentBlocker: scriptlet engine ready in %.0f ms", (CACurrentMediaTime() - started) * 1000)
      DispatchQueue.main.async { [weak self] in
        guard let self, generation == self.engineGeneration else {
          if let loaded { bay_blocker_free(loaded) }
          return
        }
        self.replaceEngine(loaded)
      }
    }
  }

  private func replaceEngine(_ next: OpaquePointer?) {
    if let engine { bay_blocker_free(engine) }
    engine = next
  }

  /// The scriptlets for a page, or nil when it has none or blocking is paused there.
  func scriptlets(for url: URL) -> String? {
    guard let engine, let host = url.host?.lowercased(), !isPaused(host),
          let pointer = url.absoluteString.withCString({ bay_blocker_scriptlets(engine, $0) }) else { return nil }
    defer { bay_string_free(pointer) }
    let script = String(cString: pointer)
    return script.isEmpty ? nil : script
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
