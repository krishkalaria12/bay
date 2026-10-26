import ExpoModulesCore
@_weakLinked import FoundationModels

/// Tidy Downloads' on-device half: Apple Intelligence proposes a short, readable name for a finished download.
///
/// The app's local cleaner (packages/core/src/tidyDownloads.ts) always runs first and gives an instant answer. On
/// Macs where the system model is available this refines that answer with the page's title and address. Neither
/// half sends anything off the Mac, and the person still chooses whether the file is renamed.
public class TidyNamesModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BayTidyNames")

    Constant("available") { () -> Bool in
      guard #available(macOS 26.0, *) else { return false }
      return SystemLanguageModel.default.availability == .available
    }

    AsyncFunction("suggest") { (filename: String, pageTitle: String, pageUrl: String, candidate: String) async -> String? in
      guard #available(macOS 26.0, *) else { return nil }
      guard SystemLanguageModel.default.availability == .available else { return nil }
      let session = LanguageModelSession(instructions: Self.instructions)
      let prompt = """
        Original file name: \(filename)
        Page title: \(pageTitle.isEmpty ? "unknown" : pageTitle)
        Page address: \(pageUrl.isEmpty ? "unknown" : pageUrl)
        Local clean-up suggested: \(candidate.isEmpty ? "none" : candidate)
        """
      do {
        let response = try await session.respond(to: prompt, options: GenerationOptions(temperature: 0.3, maximumResponseTokens: 32))
        return Self.clean(response.content)
      } catch {
        // The model can refuse or be unready; the local cleaner's answer stands.
        return nil
      }
    }
  }

  private static let instructions = """
    You name files that people download in a web browser.
    Answer with one short, readable file name in title case, 2 to 8 words.
    Keep what the file is about. When the original name is machine-made (camera counters, timestamps, IDs, hashes,
    prompts, underscores), prefer the page title's subject.
    Drop site names, usernames, dates, timestamps, camera names, IDs, hashes, counters and words like final, copy,
    download or original.
    Answer with the name only: no file extension, no quotes, no slash or colon, no sentence.
    If the original name is already what a person would choose, answer exactly KEEP.
    """

  private static func clean(_ answer: String) -> String? {
    let line = answer.split(whereSeparator: { $0.isNewline }).first.map(String.init) ?? answer
    var text = line.trimmingCharacters(in: .whitespacesAndNewlines)
    text = text.trimmingCharacters(in: CharacterSet(charactersIn: "\"'“”‘’"))
    text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let decision = text.trimmingCharacters(in: CharacterSet(charactersIn: ".!")).uppercased()
    if text.isEmpty || decision == "KEEP" { return nil }
    text = text.replacingOccurrences(of: "/", with: " ").replacingOccurrences(of: ":", with: " ")
    text = text.replacingOccurrences(of: "\n", with: " ")
    text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, text.count <= 100 else { return nil }
    return text
  }
}
