import ExpoModulesCore
@_weakLinked import FoundationModels

/// Ask on Page: Apple Intelligence answers a question about the page in front of the person, from its title, address
/// and text. The model runs on the Mac, so the page never leaves it. macOS 26 with Apple Intelligence on; elsewhere the
/// app hides the card (packages/desktop/src askPage).
public class AskPageModule: Module {
  // The system model's context is a few thousand tokens: the page's text is cut to fit beside the question.
  private static let maxPageCharacters = 9_000

  public func definition() -> ModuleDefinition {
    Name("BayAskPage")

    // As TidyTabsModule's: "available" once the model can answer.
    Function("status") { () -> String in Self.status() }

    AsyncFunction("ask") { (title: String, url: String, text: String, question: String) async -> String? in
      guard Self.status() == "available", #available(macOS 26.0, *) else { return nil }
      let page = String(text.prefix(Self.maxPageCharacters))
      let session = LanguageModelSession(instructions: Self.instructions)
      do {
        let answer = try await session.respond(
          to: "Page title: \(title)\nAddress: \(url)\n\nPage text:\n\(page)\n\nQuestion: \(question)",
          options: GenerationOptions(temperature: 0.2, maximumResponseTokens: 400))
        let content = answer.content.trimmingCharacters(in: .whitespacesAndNewlines)
        return content.isEmpty ? nil : content
      } catch {
        // The model can refuse, be busy or find the page too long; the card says it couldn't answer.
        return nil
      }
    }
  }

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
