import ExpoModulesCore
@_weakLinked import FoundationModels

/// Tidy Downloads' on-device half: Apple Intelligence proposes a short, readable name for a finished download.
///
/// The app's local cleaner (packages/core/src/tidyDownloads.ts) always runs first and gives an instant answer. On
/// Macs where the system model is available this refines that answer with the page's title and address. Neither
/// half sends anything off the Mac, and every rename can be undone.
public class TidyNamesModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BayTidyNames")

    // Whether this macOS has the model at all: `suggest` answers nil while Apple Intelligence is off or still downloading.
    Constant("available") { () -> Bool in
      if #available(macOS 26.0, *) { return true }
      return false
    }

    AsyncFunction("suggest") { (filename: String, pageTitle: String, pageUrl: String) async -> String? in
      guard #available(macOS 26.0, *) else { return nil }
      guard SystemLanguageModel.default.availability == .available else { return nil }
      let session = LanguageModelSession(instructions: Self.instructions)
      let site = URL(string: pageUrl)?.host ?? ""
      do {
        let response = try await session.respond(
          to: "Rename: \(filename), \(pageTitle), \(site)", options: GenerationOptions(temperature: 0.3, maximumResponseTokens: 32))
        return Self.clean(response.content)
      } catch {
        // The model can refuse or be unready; the local cleaner's answer stands.
        return nil
      }
    }
  }

  // The examples are what make it good: told only the rules, this model answered "Invoice", and "Cra" for Cra-0.1.30.dmg.
  private static let instructions = """
    You rename files as they finish downloading, so they are helpful, concise and readable: two to five words in title case.
    For a name that says nothing (image.png, download.pdf, IDs), use what the page's title says.
    Keep names that already say what the file is mostly as they are, and keep a version number. Add who a file is from when the page says so.
    A page's title may be about something else, like an inbox: use it only when it says what the file is.
    Remove machine-made cruft such as IDs, (1), copy, final, master, stock-photo prefixes and seconds in times; write dates short and human ("Aug 14"); fix casing and spacing.
    Answer with the new name only: no file extension, no quotes, no slash or colon, no sentence.

    Examples, as file, page title, site → new name:
    Bay-0.1.30.dmg, Bay · A fast browser, bay.app → Bay 0.1.30
    invoice_884213_2026-10-02.pdf, Your invoice from Acme Hosting - Gmail, mail.google.com → Acme Hosting Invoice Oct 2
    IMG_20260912_141533.jpg, Photos from the beach trip - Google Drive, drive.google.com → Beach Trip Sep 12
    image.png, Logo feedback - Slack, app.slack.com → Logo Feedback
    spoon-knife-main.zip, octocat/Spoon-Knife: a demo repository, github.com → Spoon Knife
    budget_final_2.xlsx, Inbox (3) - Gmail, mail.google.com → Budget
    annual-report-final(1).pdf, Annual report 2025 | Nordic Rail, nordicrail.com → Nordic Rail Annual Report 2025
    """

  private static func clean(_ answer: String) -> String? {
    let line = answer.split(whereSeparator: { $0.isNewline }).first.map(String.init) ?? answer
    var text = line.trimmingCharacters(in: .whitespacesAndNewlines)
    text = text.trimmingCharacters(in: CharacterSet(charactersIn: "\"'“”‘’"))
    text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { return nil }
    text = text.replacingOccurrences(of: "/", with: " ").replacingOccurrences(of: ":", with: " ")
    text = text.replacingOccurrences(of: "\n", with: " ")
    text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, text.count <= 100 else { return nil }
    return text
  }
}
