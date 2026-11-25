import BayImportFFI
import Foundation

/// The readers Bay's desktops share (bay-import, packages/rust/bay-import): the same answers as on Windows and Linux.
/// A request names the reader and its inputs; the answer decodes into the models here.
enum SharedReaders {
  private struct Answer<T: Decodable>: Decodable {
    struct Failure: Decodable {
      var code: String
      var message: String
    }

    var value: T?
    var error: Failure?
  }

  /// Hears the reader's events (history progress and chunks) on the reading thread.
  final class Events {
    let hear: (Data) -> Void
    init(_ hear: @escaping (Data) -> Void) { self.hear = hear }
  }

  /// Card numbers and cookie values a reader handed out of its answer, by index, kept in memory that's wiped.
  final class Secrets {
    private var items: [Int: SecretBytes] = [:]

    fileprivate func keep(_ index: Int, _ bytes: UnsafeRawBufferPointer) { items[index] = SecretBytes(copying: bytes) }

    /// The value the answer names; each one is taken once.
    func take(_ reference: Reference) -> SecretBytes {
      items.removeValue(forKey: reference.secret) ?? SecretBytes(count: 0)
    }

    /// Wipes whatever wasn't taken.
    func wipe() {
      items.values.forEach { $0.wipe() }
      items.removeAll()
    }

    /// `{"secret": n}` in an answer.
    struct Reference: Decodable {
      var secret: Int
    }
  }

  /// What the reader's hooks carry back to these callbacks.
  private final class Context {
    let events: Events?
    let secrets: Secrets?
    init(events: Events?, secrets: Secrets?) {
      self.events = events
      self.secrets = secrets
    }
  }

  static func read<T: Decodable>(_ request: [String: Any], as: T.Type, cancellation: Cancellation? = nil,
                                 events: Events? = nil, secrets: Secrets? = nil) throws -> T {
    let text = String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self)
    let context = Context(events: events, secrets: secrets)
    var hooks = BayImportHooks(
      observer: events == nil ? nil : { context, event in
        guard let context, let event else { return }
        Unmanaged<Context>.fromOpaque(context).takeUnretainedValue().events?.hear(Data(bytes: event, count: strlen(event)))
      },
      opener: nil,
      secret: secrets == nil ? nil : { context, index, plain, length in
        guard let context else { return }
        Unmanaged<Context>.fromOpaque(context).takeUnretainedValue().secrets?
          .keep(index, UnsafeRawBufferPointer(start: plain, count: length))
      },
      context: Unmanaged.passUnretained(context).toOpaque()
    )
    let answer = withExtendedLifetime(context) {
      bay_import_read(text, cancellation?.token, &hooks)
    }
    defer { bay_import_string_free(answer) }
    guard let answer else { throw ImportError.unreadable("The import reader gave no answer") }
    let decoded = try JSONDecoder().decode(Answer<T>.self, from: Data(bytes: answer, count: strlen(answer)))
    if let failure = decoded.error { throw ImportError(code: failure.code, message: failure.message) }
    guard let value = decoded.value else { throw ImportError.unreadable("The import reader gave no answer") }
    return value
  }

  /// A Chromium key as the readers take it.
  static func hex(_ key: Data) -> String { key.map { String(format: "%02x", $0) }.joined() }

  /// A cookie as both cookie readers answer it, its value handed out.
  struct CookieAnswer: Decodable {
    struct Partition: Decodable {
      var topLevelSite: String
      var crossSite: Bool
    }

    var domain: String
    var name: String
    var value: Secrets.Reference
    var path: String
    var created: Double?
    var expires: Double?
    var lastAccess: Double?
    var secure: Bool
    var httpOnly: Bool
    var sameSite: String
    var priority: String
    var sourceScheme: String
    var sourcePort: Int
    var partitionKey: Partition?

    func cookie(_ secrets: Secrets) -> Cookie {
      Cookie(domain: domain, name: name, value: secrets.take(value), path: path, created: created, expires: expires,
             lastAccess: lastAccess, secure: secure, httpOnly: httpOnly, sameSite: sameSite, priority: priority,
             partition: partitionKey.map { CookiePartition(topLevelSite: $0.topLevelSite, crossSite: $0.crossSite) },
             sourceScheme: sourceScheme, sourcePort: sourcePort)
    }
  }

  /// What a tab reader answers.
  struct Tabs: Decodable {
    var tabs: [ImportedTab]
    var groups: [ImportedTabGroup]

    var open: OpenTabs { OpenTabs(tabs: tabs, groups: groups) }
  }
}

extension ImportError {
  /// The error a shared reader named.
  init(code: String, message: String) {
    switch code {
    case "cancelled": self = .cancelled
    case "notFound": self = .notFound(message)
    case "unsupported", "appBound": self = .unsupported(message)
    case "locked": self = .locked(message)
    default: self = .unreadable(message)
    }
  }
}
