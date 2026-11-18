import Foundation

/// The page scripts Bay runs in pages: one copy of each, shared with the Expo app (packages/mobile-pagescripts, D13),
/// bundled as `pagescripts.json`. A script that takes arguments reads them from `args`.
public enum PageScript: String, CaseIterable, Sendable {
  case closeReader = "close-reader"
  case favicon
  case find
  case findClear = "find-clear"
  case findStep = "find-step"
  case hideElements = "hide-elements"
  case inspect
  case markdown
  case openReader = "open-reader"
  case pageColor = "page-color"
  case pageTweaks = "page-tweaks"
  case pauseMedia = "pause-media"
  case pickParent = "pick-parent"
  case pipMedia = "pip-media"
  case seekMedia = "seek-media"
  case startPicker = "start-picker"
  case stopPicker = "stop-picker"
  case toggleMedia = "toggle-media"
  case updateReader = "update-reader"
  case watchImages = "watch-images"
  case watchMedia = "watch-media"

  private static let sources: [String: String] = {
    guard let url = Bundle(for: EngineView.self).url(forResource: "pagescripts", withExtension: "json"),
          let data = try? Data(contentsOf: url),
          let table = try? JSONDecoder().decode([String: String].self, from: data)
    else { return [:] }
    return table
  }()

  /// The script's text, with `args` declared ahead of it as JSON when it takes arguments.
  public func source(args: [String: Any]? = nil) -> String {
    let body = Self.sources[rawValue] ?? "return null;"
    guard let args, let data = try? JSONSerialization.data(withJSONObject: args), let json = String(data: data, encoding: .utf8) else {
      return body
    }
    return "const args = \(json);\n\(body)"
  }
}

extension EngineView {
  /// Runs one of Bay's page scripts and answers with its result as JSON text (see `evaluate`).
  public func runScript(_ script: PageScript, args: [String: Any]? = nil) async throws -> String {
    try await evaluate(script.source(args: args))
  }
}
