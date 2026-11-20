import CryptoKit
import Foundation
import WebKit

/// Each space's website data (cookies, storage, cache), as each desktop space has its own profile: signing in to a
/// site in one space leaves the others signed out. The personal space keeps WebKit's default store, so what it held
/// before spaces had their own stays. Persistent stores by identifier need iOS 17; before that, every space shares
/// the default store.
enum BaySpaceProfiles {
  /// The space whose data is WebKit's default store.
  static let personal = "personal"

  private static var stores: [String: WKWebsiteDataStore] = [:]

  /// The store a space's pages use.
  static func dataStore(for profile: String) -> WKWebsiteDataStore {
    guard profile != personal, !profile.isEmpty, #available(iOS 17, *) else { return .default() }
    if let store = stores[profile] { return store }
    let store = WKWebsiteDataStore(forIdentifier: identifier(of: profile))
    stores[profile] = store
    return store
  }

  /// A stable UUID for a space id, which is any string: the first 16 bytes of its SHA-256, marked as a version 5 UUID.
  static func identifier(of profile: String) -> UUID {
    var bytes = Array(SHA256.hash(data: Data("bay-space:\(profile)".utf8)).prefix(16))
    bytes[6] = (bytes[6] & 0x0F) | 0x50
    bytes[8] = (bytes[8] & 0x3F) | 0x80
    return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                       bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
  }

  /// Clears what one store kept.
  private static func clear(_ store: WKWebsiteDataStore, _ done: @escaping () -> Void) {
    store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast, completionHandler: done)
  }

  /// Clears every space's store, the default one included.
  static func clearAll(_ done: @escaping () -> Void) {
    clear(.default()) {
      guard #available(iOS 17, *) else { return done() }
      WKWebsiteDataStore.fetchAllDataStoreIdentifiers { identifiers in
        let group = DispatchGroup()
        for identifier in identifiers {
          group.enter()
          clear(WKWebsiteDataStore(forIdentifier: identifier)) { group.leave() }
        }
        group.notify(queue: .main, execute: done)
      }
    }
  }

  /// A deleted space's data goes with it: cleared at once, and the store itself once no page holds it.
  static func delete(_ profile: String, _ done: @escaping () -> Void) {
    guard profile != personal, !profile.isEmpty, #available(iOS 17, *) else { return done() }
    let store = stores.removeValue(forKey: profile) ?? WKWebsiteDataStore(forIdentifier: identifier(of: profile))
    clear(store) {
      WKWebsiteDataStore.remove(forIdentifier: identifier(of: profile)) { _ in done() }
    }
  }
}
