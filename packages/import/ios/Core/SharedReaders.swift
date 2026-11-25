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

  static func read<T: Decodable>(_ request: [String: Any], as: T.Type, cancellation: Cancellation? = nil,
                                 events: Events? = nil) throws -> T {
    let text = String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self)
    let context = events.map { Unmanaged.passUnretained($0).toOpaque() }
    let observer: BayImportObserver? = events == nil ? nil : { context, event in
      guard let context, let event else { return }
      Unmanaged<Events>.fromOpaque(context).takeUnretainedValue().hear(Data(bytes: event, count: strlen(event)))
    }
    let answer = withExtendedLifetime(events) {
      bay_import_read(text, cancellation?.token, observer, context)
    }
    defer { bay_import_string_free(answer) }
    guard let answer else { throw ImportError.unreadable("The import reader gave no answer") }
    let decoded = try JSONDecoder().decode(Answer<T>.self, from: Data(bytes: answer, count: strlen(answer)))
    if let failure = decoded.error { throw ImportError(code: failure.code, message: failure.message) }
    guard let value = decoded.value else { throw ImportError.unreadable("The import reader gave no answer") }
    return value
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
