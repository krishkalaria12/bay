import ExpoModulesCore
@_weakLinked import FoundationModels

/// Ask on Page: Apple Intelligence answers a question about the page in front of the person, from its title, address
/// and text. The model runs on the Mac, so the page never leaves it. macOS 26 with Apple Intelligence on; elsewhere the
/// app hides the card (packages/desktop/src askPage).
public class AskPageModule: Module {
  // The system model's context is a few thousand tokens: a page longer than one part is read a part at a time, the
  // model noting what in each bears on the question, and the answer comes from the notes. Up to five parts.
  private static let maxPageCharacters = 9_000
  private static let maxPageParts = 5

  public func definition() -> ModuleDefinition {
    Name("BayAskPage")

    // As TidyTabsModule's: "available" once the model can answer.
    Function("status") { () -> String in Self.status() }

    AsyncFunction("ask") { (title: String, url: String, text: String, question: String) async -> String? in
      guard Self.status() == "available", #available(macOS 26.0, *) else { return nil }
      let parts = Self.parts(of: text)
      do {
        let page: String
        if parts.count > 1 {
          var notes: [String] = []
          for (i, part) in parts.enumerated() {
            if let found = try await Self.notes(on: part, part: i + 1, of: parts.count, question: question) { notes.append(found) }
          }
          page = notes.isEmpty ? "(Nothing in the page bears on the question.)" : "Notes from the page, in order:\n" + notes.joined(separator: "\n")
        } else {
          page = "Page text:\n" + (parts.first ?? "")
        }
        let session = LanguageModelSession(instructions: Self.instructions)
        let answer = try await session.respond(
          to: "Page title: \(title)\nAddress: \(url)\n\n\(page)\n\nQuestion: \(question)",
          options: GenerationOptions(temperature: 0.2, maximumResponseTokens: 400))
        let content = answer.content.trimmingCharacters(in: .whitespacesAndNewlines)
        return content.isEmpty ? nil : content
      } catch {
        // The model can refuse, be busy or find a part too long; the card says it couldn't answer.
        return nil
      }
    }
  }

  /// The page's text in parts the model can read, split between lines where it can be.
  private static func parts(of text: String) -> [String] {
    var parts: [String] = []
    var current = ""
    var length = 0
    for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
      let piece = String(line.prefix(maxPageCharacters))
      if length + piece.count + 1 > maxPageCharacters, !current.isEmpty {
        parts.append(current)
        if parts.count == maxPageParts { return parts }
        current = ""
        length = 0
      }
      current += current.isEmpty ? piece : "\n" + piece
      length += piece.count + 1
    }
    if !current.isEmpty { parts.append(current) }
    return parts
  }

  /// What one part of a long page says that bears on the question; nil when it says nothing that does.
  @available(macOS 26.0, *)
  private static func notes(on part: String, part index: Int, of count: Int, question: String) async throws -> String? {
    let session = LanguageModelSession(instructions: noteInstructions)
    let answer = try await session.respond(
      to: "Part \(index) of \(count) of the page:\n\(part)\n\nQuestion: \(question)",
      options: GenerationOptions(temperature: 0.1, maximumResponseTokens: 200))
    let content = answer.content.trimmingCharacters(in: .whitespacesAndNewlines)
    return content.isEmpty || content.uppercased().hasPrefix("NONE") ? nil : content
  }

  private static let noteInstructions = """
    You read one part of a long web page for someone who will answer a question about the whole page.
    Write down only what this part says that helps answer the question, as a few short notes, quoting numbers, names
    and dates exactly. If this part says nothing that helps, write NONE.
    """

  private static let instructions = """
    You answer questions about the web page the user is reading, using only the page text you are given.
    Answer in two to five short sentences or a short list, in the language of the question.
    If the page doesn't say, answer that the page doesn't say, and don't guess.
    Quote numbers, names and dates exactly as the page gives them.
    """

  private static func status() -> String {
    if let forced = ProcessInfo.processInfo.environment["BAY_TIDY_MODEL_STATUS"] { return forced }
    guard #available(macOS 26.0, *) else { return "needsNewerMacOS" }
    switch SystemLanguageModel.default.availability {
    case .available: return "available"
    default: return "unavailable"
    }
  }
}
