import Foundation

/// A profile's history (Chromium's History or Firefox's places.sqlite), newest first, read by the shared reader
/// (bay-import). Progress, and the entries themselves in chunks when streaming, go to the observer.
public enum HistoryReader {
  public enum Flavor { case chromium, firefox }

  private struct Event: Decodable {
    var type: String
    var phase: String?
    var processed: Int?
    var total: Int?
    var entries: String?
  }

  private struct Read: Decodable {
    var entries: [HistoryEntry]
    var count: Int
  }

  public static func read(_ db: URL, flavor: Flavor, options: ImportOptions = .init(),
                          observer: ImportObserver = .silent, cancellation: Cancellation = .init()) throws -> (entries: [HistoryEntry], count: Int) {
    let stream = options.streamHistory && observer.history != nil
    var request: [String: Any] = [
      "reader": "history", "profile": db.deletingLastPathComponent().path, "firefox": flavor == .firefox,
      "chunkSize": observer.chunkSize, "stream": stream,
    ]
    if let limit = options.historyLimit { request["limit"] = limit }
    if let since = options.historySince { request["since"] = since }
    let events = SharedReaders.Events { data in
      guard let event = try? JSONDecoder().decode(Event.self, from: data) else { return }
      if event.type == "history", let text = event.entries,
         let entries = try? JSONDecoder().decode([HistoryEntry].self, from: Data(text.utf8)) {
        observer.history?(entries)
      } else if event.type == "progress", let phase = event.phase.flatMap(ImportProgress.Phase.init(rawValue:)) {
        observer.progress(ImportProgress(kind: .history, phase: phase, processed: event.processed ?? 0, total: event.total))
      }
    }
    let read = try SharedReaders.read(request, as: Read.self, cancellation: cancellation, events: events)
    return (read.entries, read.count)
  }
}
