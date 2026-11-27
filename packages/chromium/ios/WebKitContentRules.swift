import Foundation
import WebKit

/// Ad blocking on WebKit pages (Settings › Privacy's lists, the same ones Chromium pages use): bay-lists turns the
/// chosen lists into WebKit content rules (bay_lists_webkit_rules, packages/rust/bay-lists), and this compiles them into
/// WKContentRuleLists, a chunk per list under WebKit's limit, kept in WebKit's own store by the lists' key. A launch
/// with the same lists only looks them up. Network rules and element hiding (css-display-none) convert; scriptlets
/// don't, so a few ads on a few sites get through. A site the blocker is paused on, or a blocker turned off, gets no
/// rules: they're set per page as its main frame navigates.
final class WebKitContentRules {
  static let shared = WebKitContentRules()

  // WebKit refuses a rule list above about 150,000 rules; smaller ones compile faster too.
  private static let rulesPerList = 50_000
  private static let identifierPrefix = "bay-blocker-"
  private static let keyDefault = "BayWebKitRulesKey"
  private static let countDefault = "BayWebKitRulesCount"

  private(set) var lists: [WKContentRuleList] = []
  private var enabled = true
  private var paused: [String] = []
  private var key: String?
  private var compiling = false
  private var again = false
  private var started = false

  /// Every WebKit page's rules, once: now and whenever the blocker changes.
  func start() {
    guard !started else { return }
    started = true
    // Run as the change is posted (on the main thread), before a reload it led to asks for the page's rules.
    NotificationCenter.default.addObserver(forName: .NNCoreContentBlockerChanged, object: nil, queue: nil) { [weak self] _ in
      self?.refresh()
    }
    refresh()
  }

  /// The rules for a page on `host`: none where the blocker is off or paused on the site.
  func rules(forHost host: String?) -> [WKContentRuleList] {
    guard enabled, let host = host?.lowercased(), !host.isEmpty else { return enabled ? lists : [] }
    return paused.contains { host == $0 || host.hasSuffix("." + $0) } ? [] : lists
  }

  /// Puts the rules for `url`'s host on a page's content controller, before its main frame loads it.
  func apply(to controller: WKUserContentController, url: URL?) {
    controller.removeAllContentRuleLists()
    for list in rules(forHost: url?.host) { controller.add(list) }
  }

  private func refresh() {
    let state = NNCoreContentBlocker.webKitRulesState()
    enabled = state["enabled"] as? Bool ?? false
    paused = ((state["paused"] as? [String]) ?? []).map { $0.lowercased() }
    reapply()
    guard enabled else { return }
    NNCoreContentBlocker.webKitRulesKey { [weak self] key in
      guard let self, key != self.key else { return }
      self.load(key)
    }
  }

  private func reapply() {
    for tab in WebKitHub.shared.liveTabs() {
      guard let view = tab.webView else { continue }
      apply(to: view.configuration.userContentController, url: view.url)
    }
  }

  /// The compiled lists for `key`: from WebKit's store when they're there, else compiled now.
  private func load(_ key: String) {
    if compiling {
      again = true
      return
    }
    compiling = true
    let store = WKContentRuleListStore.default()!
    let prefix = Self.identifierPrefix + Self.stableHash(key) + "-"
    let finish = { [weak self] (compiled: [WKContentRuleList]?) in
      guard let self else { return }
      self.compiling = false
      if let compiled {
        self.lists = compiled
        self.key = key
        self.reapply()
        Self.removeStale(except: prefix, store: store)
      }
      if self.again {
        self.again = false
        self.refresh()
      }
    }
    let defaults = UserDefaults.standard
    if defaults.string(forKey: Self.keyDefault) == key, defaults.integer(forKey: Self.countDefault) > 0 {
      return Self.lookUp(prefix: prefix, count: defaults.integer(forKey: Self.countDefault), store: store) { found in
        if let found { return finish(found) }
        self.compile(prefix: prefix, key: key, store: store, finish: finish)
      }
    }
    compile(prefix: prefix, key: key, store: store, finish: finish)
  }

  private func compile(prefix: String, key: String, store: WKContentRuleListStore, finish: @escaping ([WKContentRuleList]?) -> Void) {
    NNCoreContentBlocker.webKitRules { json in
      DispatchQueue.global(qos: .utility).async {
        guard let json, let rules = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [Any] else {
          NSLog("[webkit] content rules couldn't be read")
          return DispatchQueue.main.async { finish(nil) }
        }
        let chunks = stride(from: 0, to: rules.count, by: Self.rulesPerList).map { Array(rules[$0..<min($0 + Self.rulesPerList, rules.count)]) }
        DispatchQueue.main.async {
          Self.compileChunks(chunks, index: 0, prefix: prefix, store: store, compiled: []) { compiled in
            if let compiled {
              UserDefaults.standard.set(key, forKey: Self.keyDefault)
              UserDefaults.standard.set(compiled.count, forKey: Self.countDefault)
              NSLog("[webkit] %d content rules in %d lists", rules.count, compiled.count)
            }
            finish(compiled)
          }
        }
      }
    }
  }

  private static func compileChunks(_ chunks: [[Any]], index: Int, prefix: String, store: WKContentRuleListStore, compiled: [WKContentRuleList],
                                    completion: @escaping ([WKContentRuleList]?) -> Void) {
    guard index < chunks.count else { return completion(compiled) }
    guard let data = try? JSONSerialization.data(withJSONObject: chunks[index]), let encoded = String(data: data, encoding: .utf8) else {
      return completion(nil)
    }
    store.compileContentRuleList(forIdentifier: "\(prefix)\(index)", encodedContentRuleList: encoded) { list, error in
      guard let list else {
        NSLog("[webkit] content rules didn't compile: %@", error?.localizedDescription ?? "no list")
        return completion(nil)
      }
      compileChunks(chunks, index: index + 1, prefix: prefix, store: store, compiled: compiled + [list], completion: completion)
    }
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

  private static func removeStale(except prefix: String, store: WKContentRuleListStore) {
    store.getAvailableContentRuleListIdentifiers { identifiers in
      for identifier in identifiers ?? [] where identifier.hasPrefix(identifierPrefix) && !identifier.hasPrefix(prefix) {
        store.removeContentRuleList(forIdentifier: identifier) { _ in }
      }
    }
  }

  /// FNV-1a: the same across launches, unlike Hasher.
  static func stableHash(_ text: String) -> String {
    var hash: UInt64 = 0xcbf2_9ce4_8422_2325
    for byte in text.utf8 { hash = (hash ^ UInt64(byte)) &* 0x100_0000_01b3 }
    return String(hash, radix: 16)
  }
}
