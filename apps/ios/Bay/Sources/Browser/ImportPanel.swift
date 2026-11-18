import BayCore
import BayDesign
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Bringing bookmarks, history and favorites from another browser. A phone's browsers keep their data to themselves,
/// so the sheet lists the ones on this phone and walks through how each hands its data over: Safari's export, Google
/// Takeout for Chrome, a bookmarks file for the rest, or a pasted list of tabs. The chosen file is read on the phone
/// (the core reads only its bookmark pages and history files); what it held is reviewed before anything is added.
struct ImportPanel: View {
  private enum Step {
    case sources
    case guide(PhoneBrowser)
    case paste
    case review(PhoneBrowser, ChosenExport, ImportChoice)
    case done(ImportCounts)
  }

  /// "Another browser": any that can save its bookmarks as a file.
  private static let another = PhoneBrowser(id: "other", name: "", method: .bookmarksFile, icon: nil)

  @EnvironmentObject private var strings: Strings
  @ObservedObject var browser: BrowserModel
  @State private var step = Step.sources
  @State private var browsers: [PhoneBrowser] = []
  @State private var choosing = false
  @State private var reading = false
  @State private var readError: String?

  var body: some View {
    content
      // Each opening starts at the list, which looks at the phone again: a browser may have been installed meanwhile.
      .onAppear {
        let queryable = iosQueryableBrowsers()
        let answered = queryable.map { URL(string: $0.url).map(UIApplication.shared.canOpenURL) ?? false }
        browsers = iosBrowsers(answered: answered)
      }
      .fileImporter(isPresented: $choosing, allowedContentTypes: [.item]) { result in
        guard case .guide(let phone) = step, case .success(let url) = result else { return }
        read(url, from: phone)
      }
  }

  @ViewBuilder private var content: some View {
    switch step {
    case .sources: sources
    case .guide(let phone): guide(phone)
    case .paste:
      let title = strings.t("import.paste.title")
      PanelSheet(title: title, testID: "import-screen", words: strings.sheetWords(title), onClose: close, onBack: back) {
        PasteTabs(browser: browser)
      }
    case .review(let phone, let chosen, let choice): review(phone, chosen, choice)
    case .done(let counts): done(counts)
    }
  }

  private func close() {
    browser.panel = nil
  }

  private func back() {
    readError = nil
    step = .sources
  }

  private func nameOf(_ phone: PhoneBrowser) -> String {
    phone.name.isEmpty ? strings.t("import.another") : phone.name
  }

  private var sources: some View {
    let title = strings.t("import.title")
    return PanelSheet(title: title, testID: "import-screen", words: strings.sheetWords(title), onClose: close) {
      BayText(strings.t("import.help"), variant: .subhead, tone: .muted)
      RowGroup(strings.t("import.onThisPhone")) {
        ForEach(browsers, id: \.id) { phone in
          ActionRow(
            phone.name, testID: "import-browser-\(phone.id)", detail: strings.t(Self.methodDetail(phone.method)), chevron: true,
            leading: AnyView(Initial(name: phone.name))
          ) {
            readError = nil
            step = .guide(phone)
          }
          RowDivider()
        }
        ActionRow(strings.t("import.another"), testID: "import-browser-other", icon: .import, detail: strings.t("import.method.file"), chevron: true) {
          readError = nil
          step = .guide(Self.another)
        }
        RowDivider()
        ActionRow(strings.t("import.pasteTabs"), testID: "import-paste-tabs", icon: .tabs, detail: strings.t("import.method.paste"), chevron: true) {
          step = .paste
        }
      }
      .padding(.top, Space.md)
      VStack(alignment: .leading, spacing: 4) {
        BayText(strings.t("import.passwords.title"), variant: .callout, weight: .semibold)
        BayText(strings.t("import.passwords.ios"), variant: .subhead, tone: .muted)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(Space.lg)
      .background(BayColor.fill, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
      .padding(.top, Space.lg)
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("import-passwords")
    }
  }

  private func guide(_ phone: PhoneBrowser) -> some View {
    let title = nameOf(phone)
    return PanelSheet(title: title, testID: "import-screen", words: strings.sheetWords(title), onClose: close, onBack: reading ? nil : { back() }) {
      Guide(method: phone.method, name: title, named: !phone.name.isEmpty)
      if let readError {
        BayText(readError, variant: .subhead, tone: .danger)
          .padding(.top, Space.md)
          .accessibilityIdentifier("import-error")
          .accessibilityAddTraits(.updatesFrequently)
      }
      HStack(spacing: Space.sm) {
        Spacer(minLength: 0)
        if phone.method == .takeout {
          PillButton(strings.t("import.takeout.open")) {
            close()
            browser.openListed(takeoutUrl())
          }
          .disabled(reading)
          .accessibilityLabel(Text(verbatim: strings.t("import.takeout.openLabel")))
          .accessibilityIdentifier("import-takeout")
        }
        PillButton(reading ? strings.t("import.reading") : strings.t("import.choose")) {
          readError = nil
          choosing = true
        }
        .disabled(reading)
        .opacity(reading ? 0.4 : 1)
        .accessibilityLabel(Text(verbatim: strings.t("import.chooseLabel")))
        .accessibilityIdentifier("import-choose")
      }
      .padding(.top, Space.lg)
    }
  }

  private func review(_ phone: PhoneBrowser, _ chosen: ChosenExport, _ choice: ImportChoice) -> some View {
    let title = strings.t("import.review.title")
    let contents = chosen.contents
    let folder = phone.name.isEmpty ? strings.t("import.importedFolder") : phone.name
    let bookmarks = Int(importedLinkCount(node: contents.bookmarks))
    let favorites = contents.favorites.count
    let history = contents.history.count
    let limit = Int(historyLimit())
    let notes = chosen.notes
    let left =
      notes.passwords && notes.cards
      ? "import.left.both" : notes.passwords ? "import.left.passwords" : notes.cards ? "import.left.cards" : nil
    let set = { (next: ImportChoice) in step = .review(phone, chosen, next) }
    return PanelSheet(title: title, testID: "import-screen", words: strings.sheetWords(title), onClose: close, onBack: back) {
      BayText(strings.t("import.review.from", ["name": chosen.name]), variant: .subhead, tone: .muted).lineLimit(2)
        .accessibilityIdentifier("import-review-file")
      RowGroup {
        if bookmarks > 0 {
          ActionRow(
            bookmarks == 1 ? strings.t("bookmarks.folderOne") : strings.t("bookmarks.folderCount", ["count": "\(bookmarks)"]),
            testID: "import-review-bookmarks", icon: .bookmark, detail: strings.t("import.review.bookmarksDetail", ["folder": folder]),
            toggle: choice.bookmarks
          ) { set(ImportChoice(bookmarks: !choice.bookmarks, favorites: choice.favorites, history: choice.history)) }
        }
        if favorites > 0 {
          if bookmarks > 0 { RowDivider() }
          ActionRow(
            favorites == 1 ? strings.t("import.review.favoriteOne") : strings.t("import.review.favorites", ["count": "\(favorites)"]),
            testID: "import-review-favorites", icon: .pin, detail: strings.t("import.review.favoritesDetail"), toggle: choice.favorites
          ) { set(ImportChoice(bookmarks: choice.bookmarks, favorites: !choice.favorites, history: choice.history)) }
        }
        if history > 0 {
          if bookmarks > 0 || favorites > 0 { RowDivider() }
          ActionRow(
            history == 1 ? strings.t("settings.historyOnePage") : strings.t("settings.historyPages", ["count": "\(history)"]),
            testID: "import-review-history", icon: .history,
            detail: history > limit
              ? strings.t("import.review.historyNewest", ["count": "\(limit)"]) : strings.t("import.review.historyDetail"),
            toggle: choice.history
          ) { set(ImportChoice(bookmarks: choice.bookmarks, favorites: choice.favorites, history: !choice.history)) }
        }
      }
      .padding(.top, Space.md)
      if let left {
        BayText(strings.t(left), variant: .footnote, tone: .muted).padding(.top, Space.md).accessibilityIdentifier("import-review-left")
      }
      HStack {
        Spacer(minLength: 0)
        let any = choice.bookmarks || choice.favorites || choice.history
        PillButton(strings.t("import.review.import")) {
          step = .done(browser.importExport(chosen, choice: choice, folderName: folder))
        }
        .disabled(!any)
        .opacity(any ? 1 : 0.4)
        .accessibilityLabel(Text(verbatim: strings.t("import.review.importLabel")))
        .accessibilityIdentifier("import-confirm")
      }
      .padding(.top, Space.lg)
    }
  }

  private func done(_ counts: ImportCounts) -> some View {
    let title = strings.t("import.done.title")
    func count(_ value: UInt32, _ one: String, _ many: String) -> String? {
      value == 0 ? nil : value == 1 ? strings.t(one) : strings.t(many, ["count": "\(value)"])
    }
    let lines = [
      count(counts.bookmarks, "bookmarks.folderOne", "bookmarks.folderCount"),
      count(counts.favorites, "import.review.favoriteOne", "import.review.favorites"),
      count(counts.history, "settings.historyOnePage", "settings.historyPages"),
    ].compactMap { $0 }
    return PanelSheet(title: title, testID: "import-screen", words: strings.sheetWords(title), onClose: close) {
      VStack(alignment: .leading, spacing: 4) {
        BayText(lines.isEmpty ? strings.t("import.done.nothing") : strings.t("import.done.added"), variant: .headline)
        ForEach(lines, id: \.self) { BayText($0, tone: .muted) }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("import-done")
      HStack(spacing: Space.sm) {
        Spacer(minLength: 0)
        if counts.bookmarks > 0 {
          PillButton(strings.t("import.done.showBookmarks")) { browser.panel = .bookmarks }.accessibilityIdentifier("import-show-bookmarks")
        }
        PillButton(strings.t("import.done.finish"), action: close).accessibilityIdentifier("import-finish")
      }
      .padding(.top, Space.xl)
    }
  }

  /// Copies the chosen file out of where Files keeps it, has the core read it, and deletes the copy however the read
  /// ends, so nothing the export held is kept outside what's imported.
  private func read(_ url: URL, from phone: PhoneBrowser) {
    reading = true
    readError = nil
    let messages = (
      tooLarge: strings.t("import.error.tooLarge", ["name": "{name}"]), nothing: strings.t("import.error.nothing", ["name": "{name}"]),
      unreadable: strings.t("import.error.unreadable")
    )
    Task.detached(priority: .userInitiated) {
      let result: Result<ChosenExport, Error> = Result {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("bay-import", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let copy = folder.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: copy) }
        try FileManager.default.copyItem(at: url, to: copy)
        return try readExportFile(path: copy.path, name: url.lastPathComponent)
      }
      await MainActor.run {
        reading = false
        switch result {
        case .success(let chosen):
          let contents = chosen.contents
          step = .review(
            phone, chosen,
            ImportChoice(
              bookmarks: importedLinkCount(node: contents.bookmarks) > 0, favorites: !contents.favorites.isEmpty,
              history: !contents.history.isEmpty))
        case .failure(ExportReadError.NothingToImport(let name, let tooLarge)):
          readError = (tooLarge ? messages.tooLarge : messages.nothing).replacingOccurrences(of: "{name}", with: name)
        case .failure:
          readError = messages.unreadable
        }
      }
    }
  }

  /// What each way in says under its name in the list.
  private static func methodDetail(_ method: ImportMethod) -> String {
    switch method {
    case .safari: return "import.method.safari"
    case .takeout: return "import.method.takeout"
    case .bookmarksFile: return "import.method.file"
    case .paste: return "import.method.paste"
    }
  }
}

/// A browser's initial on a tile: iOS doesn't share other apps' icons.
private struct Initial: View {
  let name: String

  var body: some View {
    BayText(String(name.prefix(1)).uppercased(), variant: .footnote, weight: .semibold)
      .frame(width: IconSize.control + 6, height: IconSize.control + 6)
      .background(BayColor.foreground.opacity(0.1), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      .accessibilityHidden(true)
  }
}

/// The steps that get a browser's data into a file Bay can open.
private struct Guide: View {
  @EnvironmentObject private var strings: Strings
  let method: ImportMethod
  let name: String
  let named: Bool

  var body: some View {
    let steps: [String] =
      switch method {
      case .safari: ["import.safari.step1", "import.safari.step2", "import.safari.step3"].map { strings.t($0) }
      case .takeout: ["import.takeout.step1", "import.takeout.step2", "import.takeout.step3"].map { strings.t($0) }
      default: [
          named ? strings.t("import.file.step1", ["name": name]) : strings.t("import.file.step1Any"), strings.t("import.file.step2"),
          strings.t("import.file.step3"),
        ]
      }
    VStack(alignment: .leading, spacing: Space.md) {
      ForEach(Array(steps.enumerated()), id: \.offset) { index, text in
        HStack(alignment: .top, spacing: Space.md) {
          BayText("\(index + 1)", variant: .footnote, weight: .semibold)
            .frame(width: 26, height: 26)
            .background(BayColor.fill, in: Circle())
          BayText(text, variant: .callout).frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
    // The steps read as one, in order.
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("import-guide")
  }
}

/// A list of tabs pasted from another browser (Arc Search shares its open tabs as text), opened or archived.
private struct PasteTabs: View {
  @EnvironmentObject private var strings: Strings
  @ObservedObject var browser: BrowserModel
  @State private var text = ""
  @State private var pasteFailed = false

  var body: some View {
    let tabs = importedTabs(text: text)
    let count = tabs.count
    BayText(strings.t("import.paste.help"), variant: .subhead, tone: .muted)
    ZStack(alignment: .topLeading) {
      if text.isEmpty {
        BayText("https://example.com\nhttps://another.com", variant: .callout, tone: .muted)
          .padding(.top, 8)
          .padding(.leading, 5)
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
      TextEditor(text: $text)
        .font(.system(size: TextVariant.callout.size))
        .textInputAutocapitalization(.never)
        .disableAutocorrection(true)
        .frame(minHeight: 150)
        .modifier(ClearEditorBackground())
        .accessibilityLabel(Text(verbatim: strings.t("import.field")))
        .accessibilityIdentifier("import-text")
    }
    .padding(Space.md)
    .background(BayColor.fill, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
    .padding(.top, Space.md)
    HStack {
      let found = count == 0 ? strings.t("import.none") : count == 1 ? strings.t("import.oneLink") : strings.t("import.linksFound", ["count": "\(count)"])
      BayText(found, variant: .subhead, tone: .muted).accessibilityIdentifier("import-count")
      Spacer(minLength: 0)
      PillButton(strings.t("import.paste"), compact: true) {
        if let pasted = UIPasteboard.general.string {
          pasteFailed = false
          text = pasted
        } else {
          pasteFailed = true
        }
      }
      .accessibilityLabel(Text(verbatim: strings.t("import.pasteLabel")))
      .accessibilityIdentifier("import-paste")
    }
    .padding(.top, Space.sm)
    if pasteFailed {
      BayText(strings.t("import.pasteFailed"), variant: .subhead, tone: .danger).padding(.top, Space.sm).accessibilityIdentifier("import-paste-error")
    }
    HStack(spacing: Space.sm) {
      Spacer(minLength: 0)
      PillButton(strings.t("import.archive")) { browser.importLinks(tabs, archive: true) }
        .disabled(count == 0)
        .opacity(count == 0 ? 0.4 : 1)
        .accessibilityLabel(Text(verbatim: strings.t("import.archiveLabel")))
        .accessibilityIdentifier("import-archive")
      PillButton(strings.t("import.open")) { browser.importLinks(tabs, archive: false) }
        .disabled(count == 0)
        .opacity(count == 0 ? 0.4 : 1)
        .accessibilityLabel(Text(verbatim: strings.t("import.openLabel")))
        .accessibilityIdentifier("import-open")
    }
    .padding(.top, Space.lg)
    BayText(strings.t("import.note"), variant: .caption, tone: .muted).padding(.top, Space.md)
  }
}

/// A TextEditor shows its own white ground until iOS 16 lets it go.
private struct ClearEditorBackground: ViewModifier {
  func body(content: Content) -> some View {
    if #available(iOS 16, *) {
      content.scrollContentBackground(.hidden)
    } else {
      content.onAppear { UITextView.appearance().backgroundColor = .clear }
    }
  }
}
