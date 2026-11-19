import BayCore
import BayDesign
import BayEngine
import SwiftUI
import UniformTypeIdentifiers

/// How many history entries the sheet lists at once.
private let historyShown: UInt32 = 200

/// How far a row is swiped before it is removed, and how far it slides away then.
private let removeDistance: CGFloat = 96
private let removeWidth: CGFloat = 400

// MARK: History

/// The space's history by day, searchable, each page a tap away; a row swipes (or its button taps) out of the list.
struct HistoryPanel: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel
  @State private var query = ""
  @State private var confirming = false

  var body: some View {
    let title = strings.t("history.title")
    let space = app.activeSpaceId
    let any = !app.store.history(spaceId: space, query: "", offset: 0, limit: 1).isEmpty
    let entries = app.store.history(spaceId: space, query: query.trimmingCharacters(in: .whitespaces), offset: 0, limit: historyShown)
    PanelSheet(title: title, testID: "history-screen", words: strings.sheetWords(title), onClose: { browser.panel = nil }) {
      SheetSearchField(text: $query, placeholder: strings.t("history.search"), testID: "history-search")
      if !any {
        EmptyNote(title: strings.t("history.empty"), detail: strings.t("history.emptyDetail"), testID: "history-empty")
      } else if entries.isEmpty {
        NoMatches(text: strings.t("history.noMatches", ["query": query.trimmingCharacters(in: .whitespaces)]), testID: "history-no-matches")
      } else {
        ForEach(dayGroups(entries, at: \.lastVisit), id: \.id) { group in
          SectionLabel(strings.t("history.group.\(group.id)"))
          ForEach(group.entries, id: \.url) { entry in
            let rowTitle = pageTitle(title: entry.title, url: entry.url)
            SiteRow(
              url: entry.url, title: rowTitle, detail: "\(siteName(url: entry.url)) · \(clockTime(entry.lastVisit, strings.locale))",
              openLabel: strings.t("history.openLabel", ["title": rowTitle]), removeLabel: strings.t("history.removeLabel", ["title": rowTitle]),
              testID: "history-open-\(entry.url)", removeTestID: "history-remove-\(entry.url)",
              onOpen: { browser.openListed(entry.url) },
              onRemove: { app.dispatch(.removeHistory(spaceId: space, url: entry.url)) })
          }
        }
      }
      if any {
        ClearFooter(
          confirming: $confirming, label: strings.t("history.clear"), confirmLabel: strings.t("history.clearAll"),
          detail: strings.t("history.clearAll.detail"), keepLabel: strings.t("history.keep"), testID: "history-clear"
        ) { app.dispatch(.clearHistory(spaceId: space)) }
      }
    }
  }
}

// MARK: Archive

/// The space's closed tabs by the day they closed, searchable; a tap brings one back as a tab.
struct ArchivePanel: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel
  @State private var query = ""
  @State private var confirming = false

  var body: some View {
    let title = strings.t("archive.title")
    let space = app.activeSpaceId
    let items = app.store.archive(spaceId: space)
    let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
    let matches = needle.isEmpty ? items : items.filter { $0.tab.title.lowercased().contains(needle) || $0.tab.url.lowercased().contains(needle) }
    PanelSheet(title: title, testID: "archive-screen", words: strings.sheetWords(title), onClose: { browser.panel = nil }) {
      if items.isEmpty {
        EmptyNote(title: strings.t("archive.empty"), detail: strings.t("archive.emptyDetail"), testID: "archive-empty")
      } else {
        SheetSearchField(text: $query, placeholder: strings.t("archive.search"), testID: "archive-search")
        if matches.isEmpty {
          NoMatches(text: strings.t("archive.noMatches", ["query": needle]), testID: "archive-no-matches")
        }
        ForEach(dayGroups(matches, at: \.closedAt), id: \.id) { group in
          SectionLabel(strings.t("history.group.\(group.id)"))
          ForEach(group.entries, id: \.tab.id) { item in
            let rowTitle = pageTitle(title: item.tab.title, url: item.tab.url)
            SiteRow(
              url: item.tab.url, title: rowTitle, detail: "\(siteName(url: item.tab.url)) · \(clockTime(item.closedAt, strings.locale))",
              openLabel: strings.t("history.openLabel", ["title": rowTitle]), removeLabel: strings.t("archive.removeLabel", ["title": rowTitle]),
              testID: "archive-restore-\(item.tab.id)", removeTestID: "archive-remove-\(item.tab.id)",
              onOpen: { browser.restoreArchived(item.tab.id) },
              onRemove: { app.dispatch(.removeArchived(id: item.tab.id)) })
          }
        }
        ClearFooter(
          confirming: $confirming, label: strings.t("archive.clear"), confirmLabel: strings.t("archive.clear"),
          detail: strings.t("archive.clear.detail"), keepLabel: strings.t("archive.keep"), testID: "archive-clear"
        ) { app.dispatch(.clearArchive(spaceId: space)) }
      }
    }
  }
}

// MARK: Bookmarks

extension BookmarkNode {
  fileprivate var id: String {
    switch self {
    case .url(let id, _, _, _, _), .folder(let id, _, _, _, _): return id
    }
  }
}

// MARK: Downloads

/// Downloads, newest first: tap a finished one to open it. Removing one only takes it off the list.
struct DownloadsPanel: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel

  var body: some View {
    let title = strings.t("downloads.title")
    // While private tabs are locked, their downloads stay out of sight too.
    let items = browser.locked ? app.downloads.filter { !$0.private } : app.downloads
    PanelSheet(title: title, testID: "downloads-panel", words: strings.sheetWords(title), onClose: { browser.panel = nil }) {
      if items.isEmpty {
        BayText(strings.t("downloads.empty"), tone: .muted).frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityIdentifier("downloads-empty")
      } else {
        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
          DownloadRow(item: item, index: index, browser: browser)
        }
        if items.contains(where: { $0.state != .downloading }) {
          ActionRow(strings.t("downloads.clearList"), testID: "downloads-clear") { app.dispatch(.clearDownloads) }
            .padding(.top, Space.md)
        }
      }
    }
  }
}

private struct DownloadRow: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  let item: DownloadItem
  let index: Int
  @ObservedObject var browser: BrowserModel

  var body: some View {
    let status = downloadStatus(item, strings)
    let running = item.state == .downloading
    HStack(spacing: Space.sm) {
      Button { browser.openDownload(item) } label: {
        VStack(alignment: .leading, spacing: 0) {
          BayText(item.filename).lineLimit(1)
          BayText(status, variant: .subhead, tone: .muted).lineLimit(1).accessibilityIdentifier("download-\(index)-status")
          if running { DownloadProgress(item: item).padding(.top, Space.sm) }
        }
        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
        .padding(.vertical, Space.sm)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(item.state != .finished)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(Text(verbatim: "\(item.filename), \(status)"))
      .accessibilityAddTraits(.isButton)
      .accessibilityIdentifier("download-\(index)")
      PillButton(running ? strings.t("downloads.cancel") : strings.t("downloads.remove"), compact: true) {
        if running {
          Engine.cancelDownload(item.id)
        } else {
          app.dispatch(.removeDownload(id: item.id))
        }
      }
      .accessibilityLabel(
        Text(
          verbatim: running
            ? strings.t("downloads.cancelLabel", ["filename": item.filename]) : strings.t("downloads.removeLabel", ["filename": item.filename]))
      )
      .accessibilityIdentifier("download-\(index)-\(running ? "cancel" : "remove")")
    }
    .overlay(alignment: .bottom) { Hairline() }
  }
}

/// A running download's bar: it eases to each new fraction, and while the size is unknown or the download is waiting a
/// short segment sweeps across instead, so it never looks frozen. The status line says the percentage in words.
struct DownloadProgress: View {
  let item: DownloadItem
  @State private var sweep = false

  var body: some View {
    let fraction = item.total > 0 && item.waiting == nil ? min(1, Double(item.received) / Double(item.total)) : nil
    GeometryReader { box in
      ZStack(alignment: .leading) {
        Capsule().fill(BayColor.fill)
        if let fraction {
          Capsule().fill(BayColor.accent).frame(width: box.size.width * fraction).animation(.easeOut(duration: 0.45), value: fraction)
        } else {
          Capsule().fill(BayColor.accent).frame(width: box.size.width * 0.35)
            .offset(x: sweep ? box.size.width : -box.size.width * 0.35)
            .onAppear {
              withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: false)) { sweep = true }
            }
        }
      }
      .clipShape(Capsule())
    }
    .frame(height: 4)
    .accessibilityHidden(true)
  }
}

/// "1.2 MB", "340 KB", with the number written the current language's way.
@MainActor
func formatBytes(_ bytes: Int64, _ strings: Strings) -> String {
  let formatter = NumberFormatter()
  formatter.locale = Locale(identifier: strings.locale)
  formatter.maximumFractionDigits = 1
  formatter.minimumFractionDigits = 1
  let decimal = { (value: Double) in formatter.string(from: NSNumber(value: value)) ?? "\(value)" }
  if bytes >= 1_000_000_000 { return "\(decimal(Double(bytes) / 1_000_000_000)) GB" }
  if bytes >= 1_000_000 { return "\(decimal(Double(bytes) / 1_000_000)) MB" }
  formatter.maximumFractionDigits = 0
  formatter.minimumFractionDigits = 0
  if bytes >= 1_000 { return "\(decimal((Double(bytes) / 1_000).rounded())) KB" }
  return strings.t("downloads.size.bytes", ["size": decimal(Double(bytes))])
}

/// What a download is doing, in a few words.
@MainActor
func downloadStatus(_ item: DownloadItem, _ strings: Strings) -> String {
  switch item.state {
  case .downloading:
    if let waiting = item.waiting { return waiting }
    if item.total > 0 {
      return strings.t(
        "downloads.status.progress",
        [
          "percent": "\(item.received * 100 / item.total)", "received": formatBytes(item.received, strings),
          "total": formatBytes(item.total, strings),
        ])
    }
    return item.received > 0 ? strings.t("downloads.status.soFar", ["size": formatBytes(item.received, strings)]) : strings.t("downloads.status.starting")
  case .finished:
    return formatBytes(item.total > 0 ? item.total : item.received, strings)
  case .cancelled:
    return strings.t("downloads.status.cancelled")
  case .failed:
    // Bay's own note is saved in English; the engine's messages arrive in the device's language already.
    if downloadInterrupted(item: item) { return strings.t("downloads.interrupted") }
    return item.error ?? strings.t("downloads.status.failed")
  }
}

// MARK: Shared pieces

/// Entries (newest first) in the day groups the core picks by the phone's calendar: Today, Yesterday, This week, Earlier.
func dayGroups<T>(_ entries: [T], at time: (T) -> Int64, now: Date = Date()) -> [(id: DayGroupId, entries: [T])] {
  let calendar = Calendar.current
  let today = calendar.startOfDay(for: now)
  let millis = { (date: Date?) in Int64((date ?? today).timeIntervalSince1970 * 1000) }
  let bounds = DayBounds(
    today: millis(today), yesterday: millis(calendar.date(byAdding: .day, value: -1, to: today)),
    week: millis(calendar.date(byAdding: .day, value: -6, to: today)))
  return groupByDay(times: entries.map(time), bounds: bounds).map { group in
    (group.id, group.entries.map { entries[Int($0)] })
  }
}

/// "14:05" or "2:05 PM", as the language writes a time.
func clockTime(_ millis: Int64, _ locale: String) -> String {
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: locale)
  formatter.dateStyle = .none
  formatter.timeStyle = .short
  return formatter.string(from: Date(timeIntervalSince1970: TimeInterval(millis) / 1000))
}

/// A sheet's search field, on the fill under the sheet's rows.
struct SheetSearchField: View {
  @Binding var text: String
  let placeholder: String
  let testID: String

  var body: some View {
    HStack(spacing: Space.sm) {
      BayIconView(.search, size: IconSize.small, color: BayColor.muted)
      TextField(placeholder, text: $text)
        .textInputAutocapitalization(.never)
        .disableAutocorrection(true)
        .submitLabel(.search)
        .accessibilityIdentifier(testID)
    }
    .padding(.horizontal, Space.lg)
    .frame(minHeight: 44)
    .background(BayColor.fill, in: Capsule())
    .padding(.bottom, Space.xs)
  }
}

/// A site's icon, title and detail line that opens it, with a remove button; swiping the row left removes it too.
struct SiteRow: View {
  let url: String
  let title: String
  let detail: String
  let openLabel: String
  let removeLabel: String
  let testID: String
  let removeTestID: String
  let onOpen: () -> Void
  let onRemove: () -> Void
  @State private var offset: CGFloat = 0
  /// A sideways drag is under way: the lift that ends it isn't a tap.
  @State private var swiping = false

  var body: some View {
    HStack(spacing: Space.md) {
      Button {
        if !swiping { onOpen() }
      } label: {
        HStack(spacing: Space.md) {
          SiteIcon(url: url)
          VStack(alignment: .leading, spacing: 0) {
            BayText(title, variant: .callout).lineLimit(1)
            BayText(detail, variant: .footnote, tone: .muted).lineLimit(1)
          }
          Spacer(minLength: 0)
        }
        .padding(.vertical, Space.sm)
        .contentShape(Rectangle())
      }
      .buttonStyle(PressFeedbackStyle())
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(Text(verbatim: openLabel))
      // The site and time, read after the title.
      .accessibilityValue(Text(verbatim: detail))
      .accessibilityAddTraits(.isButton)
      .accessibilityIdentifier(testID)
      RemoveButton(label: removeLabel, testID: removeTestID, action: onRemove)
    }
    .frame(minHeight: 56)
    .overlay(alignment: .bottom) { Hairline() }
    .offset(x: offset)
    .background(alignment: .trailing) {
      // What the swipe uncovers.
      BayIconView(.delete, size: IconSize.row, color: BayColor.danger)
        .padding(.trailing, 20)
        .opacity(Double(min(1, -offset / removeDistance)))
    }
    // Sideways only: a vertical drag scrolls the list, and a tap still opens the page.
    .simultaneousGesture(
      DragGesture(minimumDistance: 18)
        .onChanged { drag in
          guard abs(drag.translation.width) > abs(drag.translation.height) else { return }
          swiping = true
          offset = min(0, drag.translation.width)
        }
        .onEnded { drag in
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { swiping = false }
          if offset < -removeDistance || drag.predictedEndTranslation.width < -removeWidth {
            withAnimation(.easeIn(duration: 0.16)) { offset = -removeWidth }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.16, execute: onRemove)
          } else {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { offset = 0 }
          }
        })
  }
}

private struct RemoveButton: View {
  let label: String
  let testID: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      BayIconView(.close, size: IconSize.small, color: BayColor.muted).frame(width: 44, height: 44).contentShape(Rectangle())
    }
    .buttonStyle(PressFeedbackStyle())
    .accessibilityLabel(Text(verbatim: label))
    .accessibilityIdentifier(testID)
  }
}

private struct Hairline: View {
  var body: some View {
    Rectangle().fill(BayColor.foreground.opacity(0.05)).frame(height: 1)
  }
}

/// What an empty list says, in the middle of the sheet.
private struct EmptyNote: View {
  let title: String
  let detail: String
  let testID: String

  var body: some View {
    VStack(spacing: Space.sm) {
      BayText(title, variant: .headline).multilineTextAlignment(.center).accessibilityAddTraits(.isHeader)
      BayText(detail, variant: .subhead, tone: .muted).multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 48)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(testID)
  }
}

private struct NoMatches: View {
  let text: String
  let testID: String

  var body: some View {
    BayText(text, tone: .muted).multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(.vertical, Space.xxl)
      .accessibilityIdentifier(testID)
  }
}

/// The destructive row under a list that asks once before it clears everything.
private struct ClearFooter: View {
  @Binding var confirming: Bool
  let label: String
  let confirmLabel: String
  let detail: String
  let keepLabel: String
  let testID: String
  let onClear: () -> Void

  var body: some View {
    // Lined up with the rows above it: the icon in the site icon's column, the words where their titles start.
    let trash = AnyView(BayIconView(.delete, size: IconSize.control, color: BayColor.danger).frame(width: 28, height: 28))
    VStack(spacing: 0) {
      if confirming {
        ActionRow(confirmLabel, testID: "\(testID)-confirm", detail: detail, destructive: true, leading: trash, inset: 0, gap: Space.md) {
          confirming = false
          onClear()
        }
        ActionRow(keepLabel, testID: "\(testID)-cancel", leading: AnyView(Color.clear.frame(width: 28, height: 28)), inset: 0, gap: Space.md) {
          confirming = false
        }
      } else {
        ActionRow(label, testID: testID, destructive: true, leading: trash, inset: 0, gap: Space.md) { confirming = true }
      }
    }
    .padding(.top, Space.lg)
  }
}

/// The latest download, above the bar: its progress while it comes in, then Open once it's saved. A tap shows every
/// download.
struct DownloadToast: View {
  @EnvironmentObject private var strings: Strings
  @ObservedObject var browser: BrowserModel
  let item: DownloadItem

  var body: some View {
    let status = downloadStatus(item, strings)
    let finished = item.state == .finished
    let heading = finished ? strings.t("downloadToast.downloaded", ["filename": item.filename]) : item.filename
    VStack(alignment: .leading, spacing: Space.sm) {
      HStack(spacing: Space.md) {
        BayIconView(finished ? .check : item.state == .downloading ? .download : .error, size: IconSize.row,
          color: item.state == .failed ? BayColor.danger : BayColor.accent)
        Button { browser.panel = .downloads } label: {
          VStack(alignment: .leading, spacing: 0) {
            BayText(heading, weight: .medium).lineLimit(1)
            BayText(status, variant: .subhead, tone: .muted).lineLimit(1).accessibilityIdentifier("download-toast-status")
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: strings.t("downloadToast.showAll", ["filename": item.filename, "status": status])))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("download-toast")
        if finished {
          PillButton(strings.t("downloadToast.open"), compact: true) { browser.openDownload(item) }
            .accessibilityLabel(Text(verbatim: strings.t("downloadToast.openLabel", ["filename": item.filename])))
            .accessibilityIdentifier("download-toast-open")
        }
      }
      if item.state == .downloading { DownloadProgress(item: item) }
    }
    .padding(Space.md)
    .baySurface(radius: Radius.card)
    .transition(.move(edge: .bottom).combined(with: .opacity))
  }
}

/// The spaces in a row of chips: the one chosen as a capsule in its colour with its glyph and name, the others as
/// their glyph on a wash of their colour, and a + for a new space. For saving a bookmark into a space, and the
/// bookmarks drawer.
struct SpaceChips: View {
  @EnvironmentObject private var strings: Strings
  let spaces: [BrowserSpace]
  let chosen: String
  let onChoose: (String) -> Void
  var onAdd: (() -> Void)?

  var body: some View {
    ScrollViewReader { reader in
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: Space.sm) {
          ForEach(spaces, id: \.id) { space in
            let name = spaceName(space, strings)
            let selected = space.id == chosen
            Button {
              Haptics.press()
              onChoose(space.id)
            } label: {
              HStack(spacing: Space.xs) {
                SpaceGlyph(space: space, name: name, size: 22)
                if selected {
                  BayText(name, variant: .subhead, weight: .semibold, color: .white).lineLimit(1)
                }
              }
              .padding(.horizontal, selected ? Space.md : Space.sm)
              .frame(height: 40)
              .background(selected ? spaceColor(space.color) : spaceColor(space.color).opacity(0.2), in: Capsule())
            }
            .buttonStyle(.pressFeedback)
            .id(space.id)
            .accessibilityLabel(Text(verbatim: name))
            .accessibilityAddTraits(selected ? .isSelected : [])
            .accessibilityIdentifier("space-chip-\(space.id)")
          }
          if let onAdd {
            Button(action: onAdd) {
              BayIconView(.add, size: IconSize.small, color: BayColor.muted)
                .frame(width: 40, height: 40)
                .background(BayColor.fill, in: Circle())
            }
            .buttonStyle(.pressFeedback)
            .accessibilityLabel(Text(verbatim: strings.t("save.newSpace")))
            .accessibilityIdentifier("space-chip-add")
          }
        }
        .animation(Motion.settle.animation, value: chosen)
      }
      .onAppear { reader.scrollTo(chosen, anchor: .center) }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("space-chips")
  }
}

/// Saving the page as a bookmark: its title and address, the space it goes in, and the folder, as a form with Cancel
/// and Save at its top. A page already saved opens where it is, and Save moves or renames it there; Remove takes it out.
struct SavePanel: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel
  @State private var title = ""
  @State private var url = ""
  @State private var space = ""
  @State private var folder = ""
  @State private var naming = false
  @State private var folderName = ""
  @State private var saved: BookmarkLocation?

  var body: some View {
    let heading = strings.t("save.title")
    let folders = app.store.bookmarkFolders(spaceId: space)
    PanelSheet(
      title: heading, testID: "save-sheet", words: strings.sheetWords(heading), onClose: { browser.panel = nil },
      header: AnyView(formHeader(heading).environmentObject(strings))
    ) {
      VStack(spacing: Space.md) {
        RowGroup {
          HStack(spacing: Space.md) {
            SiteIcon(url: url, size: 28)
            TextField(strings.t("save.titleField"), text: $title)
              .font(TextVariant.body.font())
              .accessibilityIdentifier("save-title")
          }
          .padding(.horizontal, Space.lg)
          .frame(minHeight: 52)
          RowDivider()
          HStack(spacing: Space.md) {
            BayIconView(.link, size: IconSize.row, color: BayColor.muted).frame(width: 28)
            TextField(strings.t("save.addressField"), text: $url)
              .font(TextVariant.subhead.font())
              .foregroundColor(BayColor.muted)
              .keyboardType(.URL)
              .textInputAutocapitalization(.never)
              .disableAutocorrection(true)
              .accessibilityIdentifier("save-url")
          }
          .padding(.horizontal, Space.lg)
          .frame(minHeight: 48)
        }
        SpaceChips(spaces: app.spaces, chosen: space, onChoose: choose) {
          browser.panel = nil
          browser.newSpace()
        }
        RowGroup {
          ForEach(Array(folders.enumerated()), id: \.element.id) { index, choice in
            if index > 0 { RowDivider() }
            let top = choice.id == "bookmarks"
            ActionRow(
              top ? strings.t("save.topOfList") : choice.title, testID: "save-folder-\(choice.id)", icon: top ? .bookmark : .folder,
              selected: choice.id == folder
            ) { folder = choice.id }
            .padding(.leading, CGFloat(max(0, Int(choice.depth) - 1)) * Space.lg)
          }
          RowDivider()
          if naming {
            HStack(spacing: 14) {
              BayIconView(.folder, size: IconSize.control, color: BayColor.muted)
              TextField(strings.t("save.folderName"), text: $folderName)
                .submitLabel(.done)
                .onSubmit(makeFolder)
                .accessibilityIdentifier("save-folder-name")
            }
            .padding(.horizontal, Space.lg)
            .frame(minHeight: 52)
          } else {
            ActionRow(strings.t("save.newFolder"), testID: "save-new-folder", icon: .add) { naming = true }
          }
        }
        if let saved {
          RowGroup {
            ActionRow(strings.t("pageMenu.removeBookmark"), testID: "save-remove", icon: .delete, destructive: true) {
              app.dispatch(.removeBookmark(spaceId: saved.spaceId, id: saved.id))
              browser.panel = nil
            }
          }
        }
      }
    }
    .onAppear(perform: start)
  }

  /// ✕ to leave without saving, the title, ✓ to save.
  private func formHeader(_ heading: String) -> some View {
    HStack {
      SheetIconButton(.close, label: strings.t("save.cancel")) { browser.panel = nil }
        .accessibilityIdentifier("save-cancel")
      Spacer(minLength: 0)
      BayText(heading, variant: .headline, weight: .semibold).accessibilityAddTraits(.isHeader)
      Spacer(minLength: 0)
      Button(action: save) {
        BayIconView(.tick, size: IconSize.small, color: BayColor.accentForeground)
          .frame(width: 36, height: 36)
          .background(BayColor.accentFill, in: Circle())
      }
      .buttonStyle(.pressFeedback)
      .accessibilityLabel(Text(verbatim: strings.t("save.done")))
      .accessibilityIdentifier("save-done")
    }
  }

  /// The page's title and address, and where it's saved now, or the space showing and its last folder.
  private func start() {
    let tab = browser.activeTab
    url = browser.activeUrl
    saved = app.store.bookmarkLocation(url: url)
    title = saved?.title ?? (tab?.title.isEmpty == false ? tab!.title : siteName(url: url))
    space = saved?.spaceId ?? app.activeSpaceId
    folder = saved?.parentId ?? app.store.lastBookmarkFolder(spaceId: space)
  }

  /// Another space: its last folder, or where the page is saved in it.
  private func choose(_ id: String) {
    space = id
    folder = saved?.spaceId == id ? saved!.parentId : app.store.lastBookmarkFolder(spaceId: id)
  }

  private func makeFolder() {
    let name = folderName.trimmingCharacters(in: .whitespaces)
    naming = false
    folderName = ""
    guard !name.isEmpty else { return }
    let id = UUID().uuidString
    app.dispatch(
      .addBookmarks(
        spaceId: space,
        nodes: [.folder(id: id, parentId: "bookmarks", title: name, children: [], addedAt: AppModel.now())]))
    folder = id
  }

  /// Saves into the space and folder chosen, moving the page out of another space it was in, and says where it went.
  private func save() {
    let address = url.trimmingCharacters(in: .whitespaces)
    guard !address.isEmpty else { return }
    if let saved, saved.spaceId != space {
      app.dispatch(.removeBookmark(spaceId: saved.spaceId, id: saved.id))
    }
    if let saved, saved.spaceId == space {
      app.dispatch(.moveBookmark(spaceId: space, id: saved.id, parentId: folder, index: nil))
      app.dispatch(.renameBookmark(spaceId: space, id: saved.id, title: title, url: address))
    } else {
      app.dispatch(
        .saveBookmark(
          spaceId: space,
          bookmark: .url(id: UUID().uuidString, parentId: folder, title: title.isEmpty ? address : title, url: address, addedAt: AppModel.now())))
    }
    Haptics.done()
    browser.panel = nil
    let chosen = app.spaces.first { $0.id == space }
    let folderTitle = app.store.bookmarkFolders(spaceId: space).first { $0.id == folder && $0.id != "bookmarks" }?.title
    let place = folderTitle ?? chosen.map { spaceName($0, strings) } ?? ""
    let opened = folder
    browser.showTopNote(TopNote(text: strings.t("save.addedTo", ["place": place]), space: chosen) { [weak browser] in
      browser?.openDrawer(folder: opened)
    })
  }
}

/// The bookmarks drawer: a dark panel the height of the screen sliding out over the page from the right, a sliver of
/// the page still showing at its left. On top, the space chips; below, the space's bookmarks, folders opening where
/// they sit; a + at its foot to save the page here. Its wash is the space's colour. A sideways swipe moves to the next
/// space (switching to it); a tap on the sliver, or VoiceOver's escape, puts it away. Pulling the list down shows a
/// search through every bookmark of the space. Holding a row offers renaming it in place, moving it to another folder
/// and removing it; holding and dragging it drops it into a folder, or beside another bookmark.
struct BookmarksDrawer: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel
  @State private var open: Set<String> = []
  @State private var shift: CGFloat = 0
  /// The search field, out once the list has been pulled down, and its words.
  @State private var searching = false
  @State private var query = ""
  @FocusState private var searchFocused: Bool
  /// The row being renamed where it sits.
  @State private var renaming: String?
  /// The row whose new folder is being picked.
  @State private var moving: BookmarkTreeRow?
  /// The row being dragged to a new place.
  @State private var dragging: String?
  /// The list is scrolled to its top, where pulling it down brings the search.
  @State private var atTop = true

  /// How much of the screen the panel covers; the rest is the page's sliver.
  private static let width: CGFloat = 0.86
  /// How far past its top the list is pulled before the search shows.
  private static let pullToSearch: CGFloat = 56

  var body: some View {
    let space = app.spaces.first { $0.id == app.activeSpaceId } ?? app.spaces.first
    let color = space.map { spaceColor($0.color) } ?? BayColor.muted
    let rows = app.store.bookmarkTreeRows(spaceId: app.activeSpaceId, open: Array(open))
    let needle = query.trimmingCharacters(in: .whitespaces)
    GeometryReader { geometry in
      HStack(spacing: 0) {
        Color.black.opacity(0.35)
          .contentShape(Rectangle())
          .onTapGesture(perform: browser.closeDrawer)
          .accessibilityLabel(Text(verbatim: strings.t("drawer.close")))
          .accessibilityAddTraits(.isButton)
          .accessibilityIdentifier("drawer-close")
        VStack(alignment: .leading, spacing: Space.md) {
          SpaceChips(spaces: app.spaces, chosen: app.activeSpaceId) { id in
            query = ""
            browser.switchSpace(id, announce: false)
          }
          .padding(.horizontal, Space.lg)
          ScrollView(showsIndicators: false) {
            VStack(alignment: .leading, spacing: 2) {
              // Where the list's top is, to know when it's pulled down past it.
              GeometryReader { proxy in
                Color.clear.preference(key: DrawerPull.self, value: proxy.frame(in: .named("drawer-list")).minY)
              }
              .frame(height: 0)
              if searching { searchField }
              if searching, !needle.isEmpty {
                found(needle, rows: rows)
              } else {
                if rows.isEmpty, let space {
                  empty(spaceName(space, strings))
                }
                ForEach(rows, id: \.id) { row in
                  drawerRow(row, rows: rows)
                }
              }
            }
            .padding(.horizontal, Space.sm)
            .padding(.bottom, 80)
          }
          .coordinateSpace(name: "drawer-list")
          .onPreferenceChange(DrawerPull.self) { top in
            atTop = top > -2
            if top > Self.pullToSearch { showSearch() }
          }
        }
        .padding(.top, geometry.safeAreaInsets.top + Space.sm)
        .frame(width: geometry.size.width * Self.width)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(
          ZStack {
            Color(RGBA(0x10, 0x10, 0x12))
            LinearGradient(colors: [color.opacity(0.45), color.opacity(0.12), .clear], startPoint: .top, endPoint: .bottom)
          }
          .animation(.easeOut(duration: 0.25), value: app.activeSpaceId)
        )
        .overlay(alignment: .bottomTrailing) {
          Button {
            browser.closeDrawer()
            browser.panel = .save
          } label: {
            BayIconView(.add, size: IconSize.control, color: BayColor.foreground)
              .frame(width: 52, height: 52)
              .background(BayColor.fill, in: Circle())
          }
          .buttonStyle(.pressFeedback)
          .accessibilityLabel(Text(verbatim: strings.t("drawer.saveHere")))
          .accessibilityIdentifier("drawer-add")
          .padding(Space.lg)
          .padding(.bottom, geometry.safeAreaInsets.bottom)
        }
        .offset(x: shift * 0.3)
        // Beside the list's own scrolling, which a plain gesture here would take over.
        .simultaneousGesture(spaceSwipe)
        .environment(\.colorScheme, .dark)
      }
      .ignoresSafeArea()
    }
    .accessibilityElement(children: .contain)
    .accessibilityAddTraits(.isModal)
    .accessibilityAction(.escape, browser.closeDrawer)
    .accessibilityIdentifier("bookmarks-drawer")
    .onAppear {
      if let folder = browser.drawerFolder { open.insert(folder) }
    }
    .baySheet(isPresented: Binding(get: { moving != nil }, set: { if !$0 { moving = nil } }), maxFraction: 0.62) {
      if let moving {
        DrawerMoveSheet(row: moving, from: parent(of: moving, in: rows)) { folder in
          app.dispatch(.moveBookmark(spaceId: app.activeSpaceId, id: moving.id, parentId: folder, index: nil))
          Haptics.done()
          if folder != bookmarksRoot { open.insert(folder) }
          self.moving = nil
        }
        .environmentObject(strings)
        .environmentObject(app)
      }
    }
  }

  private func drawerRow(_ row: BookmarkTreeRow, rows: [BookmarkTreeRow]) -> some View {
    DrawerRow(
      row: row, current: row.url == browser.activeUrl, open: open.contains(row.id), renaming: renaming == row.id
    ) {
      if row.folder {
        withAnimation(Motion.settle.animation) {
          if open.contains(row.id) { open.remove(row.id) } else { open.insert(row.id) }
        }
      } else {
        browser.closeDrawer()
        browser.open(.url(row.url), privately: false)
      }
    } rename: { name in
      renaming = nil
      let title = name.trimmingCharacters(in: .whitespaces)
      guard let title = title.isEmpty ? nil : title, title != row.title else { return }
      app.dispatch(.renameBookmark(spaceId: app.activeSpaceId, id: row.id, title: title, url: nil))
    } menu: { action in
      switch action {
      case .share: browser.share(row.url)
      case .rename: renaming = row.id
      case .move: moving = row
      case .remove: app.dispatch(.removeBookmark(spaceId: app.activeSpaceId, id: row.id))
      }
    } drag: {
      dragging = row.id
    } drop: {
      drop(onto: row, rows: rows)
    }
  }

  private func showSearch() {
    guard !searching else { return }
    Haptics.tick()
    withAnimation(Motion.settle.animation) { searching = true }
    searchFocused = true
  }

  /// The search field over the list, with a button that puts it away again.
  private var searchField: some View {
    HStack(spacing: Space.sm) {
      BayIconView(.search, size: IconSize.small, color: BayColor.muted)
      TextField(strings.t("bookmarks.search"), text: $query)
        .focused($searchFocused)
        .textInputAutocapitalization(.never)
        .disableAutocorrection(true)
        .submitLabel(.search)
        .accessibilityIdentifier("drawer-search")
      Button {
        query = ""
        searchFocused = false
        withAnimation(Motion.settle.animation) { searching = false }
      } label: {
        BayIconView(.close, size: IconSize.small, color: BayColor.muted).frame(width: 32, height: 32).contentShape(Rectangle())
      }
      .buttonStyle(.pressFeedback)
      .accessibilityLabel(Text(verbatim: strings.t("search.clear")))
      .accessibilityIdentifier("drawer-search-close")
    }
    .padding(.leading, Space.lg)
    .padding(.trailing, Space.xs)
    .frame(minHeight: 44)
    .background(BayColor.fill, in: Capsule())
    .padding(.bottom, Space.sm)
    .transition(.move(edge: .top).combined(with: .opacity))
  }

  /// What the search finds in the space, whichever folder it's in; a folder found opens where it sits.
  @ViewBuilder private func found(_ needle: String, rows: [BookmarkTreeRow]) -> some View {
    let listing = app.store.bookmarkListing(spaceId: app.activeSpaceId, folderId: bookmarksRoot, query: needle)
    if listing.rows.isEmpty {
      BayText(strings.t("bookmarks.noMatches", ["query": needle]), variant: .callout, tone: .muted)
        .padding(Space.lg)
        .accessibilityIdentifier("drawer-no-matches")
    }
    ForEach(listing.rows, id: \.node.id) { found in
      switch found.node {
      case .url(let id, _, let title, let url, _):
        drawerRow(BookmarkTreeRow(id: id, folder: false, title: title, url: url, depth: 0, links: 0, open: false), rows: rows)
      case .folder(let id, _, let title, _, _):
        DrawerRow(
          row: BookmarkTreeRow(id: id, folder: true, title: title, url: "", depth: 0, links: found.links, open: false), current: false,
          open: false, renaming: false
        ) {
          query = ""
          searchFocused = false
          searching = false
          open.insert(id)
        }
      }
    }
  }

  /// The folder a row sits in: the nearest folder above it one step out, or the top of the list.
  private func parent(of row: BookmarkTreeRow, in rows: [BookmarkTreeRow]) -> String {
    guard row.depth > 0, let index = rows.firstIndex(where: { $0.id == row.id }) else { return bookmarksRoot }
    return rows[..<index].last { $0.depth == row.depth - 1 }?.id ?? bookmarksRoot
  }

  /// A dragged row let go over `target`: into it when it's a folder, else beside it, after it when dragged down.
  private func drop(onto target: BookmarkTreeRow, rows: [BookmarkTreeRow]) -> Bool {
    defer { dragging = nil }
    guard let id = dragging, id != target.id else { return false }
    let space = app.activeSpaceId
    if target.folder {
      app.dispatch(.moveBookmark(spaceId: space, id: id, parentId: target.id, index: nil))
      open.insert(target.id)
    } else {
      let folder = parent(of: target, in: rows)
      // The folder's saved order, which the drawer shows with its folders first.
      let order = app.store.bookmarkListing(spaceId: space, folderId: folder, query: "").rows.map(\.node.id)
      let rest = order.filter { $0 != id }
      guard var at = rest.firstIndex(of: target.id) else { return false }
      if let from = order.firstIndex(of: id), let to = order.firstIndex(of: target.id), from < to { at += 1 }
      app.dispatch(.moveBookmark(spaceId: space, id: id, parentId: folder, index: Int64(at)))
    }
    Haptics.tick()
    return true
  }

  /// Nothing saved in this space: say so, and offer to save the page here.
  private func empty(_ name: String) -> some View {
    VStack(alignment: .leading, spacing: Space.md) {
      BayText(strings.t("drawer.empty", ["space": name]), variant: .callout, tone: .muted)
      PillButton(strings.t("drawer.saveHere")) {
        browser.closeDrawer()
        browser.panel = .save
      }
      .accessibilityIdentifier("drawer-empty-save")
    }
    .padding(Space.lg)
  }

  /// Sideways across the list: the space before or after, switched to. Down from the list's top: the search.
  private var spaceSwipe: some Gesture {
    DragGesture(minimumDistance: 24)
      .onChanged { value in
        guard abs(value.translation.width) > abs(value.translation.height) else {
          if atTop, value.translation.height > Self.pullToSearch { showSearch() }
          return
        }
        shift = value.translation.width
      }
      .onEnded { value in
        defer { withAnimation(Motion.settle.animation) { shift = 0 } }
        guard abs(value.translation.width) > abs(value.translation.height), abs(value.translation.width) > 80,
          let index = app.spaces.firstIndex(where: { $0.id == app.activeSpaceId })
        else { return }
        let next = index + (value.translation.width < 0 ? 1 : -1)
        guard app.spaces.indices.contains(next) else { return }
        open = []
        query = ""
        browser.switchSpace(app.spaces[next].id, announce: false)
      }
  }
}

/// The top of a space's bookmarks, the folder everything else sits in.
private let bookmarksRoot = "bookmarks"

/// How far the drawer's list sits below its top: past zero while it's pulled down.
private struct DrawerPull: PreferenceKey {
  static let defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// What holding a drawer row offers.
private enum DrawerRowAction { case share, rename, move, remove }

/// One row of the drawer: a folder with its count, turning to show it's open, or a link with its site's icon. The page
/// showing sits on a light wash. Holding a link offers sharing it; holding either, renaming, moving or removing it, and
/// dragging it puts it somewhere else. While it's being renamed its name is a field.
private struct DrawerRow: View {
  @EnvironmentObject private var strings: Strings
  let row: BookmarkTreeRow
  let current: Bool
  let open: Bool
  let renaming: Bool
  let action: () -> Void
  var rename: (String) -> Void = { _ in }
  /// Nil for a row that only opens (a folder the search found).
  var menu: ((DrawerRowAction) -> Void)?
  var drag: () -> Void = {}
  var drop: () -> Bool = { false }
  @State private var name = ""
  @State private var targeted = false
  @FocusState private var naming: Bool

  var body: some View {
    let title = row.title.isEmpty ? displayUrl(url: row.url) : row.title
    Group {
      if renaming {
        HStack(spacing: Space.md) {
          icon
          TextField(title, text: $name)
            .focused($naming)
            .submitLabel(.done)
            .onSubmit { rename(name) }
            .accessibilityLabel(Text(verbatim: strings.t("drawer.rename")))
            .accessibilityIdentifier("drawer-rename-field")
        }
        .padding(.leading, Space.md + CGFloat(row.depth) * Space.lg)
        .padding(.trailing, Space.md)
        .frame(minHeight: 46)
        .background(Color.white.opacity(0.1), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .onAppear {
          name = row.title
          DispatchQueue.main.async { naming = true }
        }
        // Tapping elsewhere keeps the name typed so far.
        .onChange(of: naming) { focused in
          if !focused { rename(name) }
        }
      } else if let menu {
        button(title)
          .contextMenu {
            if !row.folder {
              Button(strings.t("drawer.share")) { menu(.share) }
            }
            Button(strings.t("drawer.rename")) { menu(.rename) }
            Button(strings.t("drawer.move")) { menu(.move) }
            Button(strings.t("drawer.remove"), role: .destructive) { menu(.remove) }
          }
          .onDrag {
            drag()
            return NSItemProvider(object: row.id as NSString)
          }
          .onDrop(of: [.plainText], isTargeted: $targeted) { _ in drop() }
      } else {
        button(title)
      }
    }
  }

  @ViewBuilder private var icon: some View {
    if row.folder {
      BayIconView(.folder, size: IconSize.row, color: BayColor.foreground).frame(width: 24)
    } else {
      SiteIcon(url: row.url, size: 24, bare: true)
    }
  }

  private func button(_ title: String) -> some View {
    Button(action: action) {
      HStack(spacing: Space.md) {
        icon
        BayText(title, weight: row.folder ? .semibold : .regular).lineLimit(1)
        Spacer(minLength: 0)
        if row.folder {
          if row.links > 0 { BayText("\(row.links)", variant: .footnote, tone: .muted) }
          BayIconView(.chevron, size: IconSize.inline, color: BayColor.muted).rotationEffect(.degrees(open ? 90 : 0))
        }
      }
      .padding(.leading, Space.md + CGFloat(row.depth) * Space.lg)
      .padding(.trailing, Space.md)
      .frame(minHeight: 46)
      .background(
        targeted ? BayColor.accent.opacity(0.3) : current ? Color.white.opacity(0.1) : .clear,
        in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.pressFeedback)
    .accessibilityLabel(Text(verbatim: row.folder ? "\(row.title), \(row.links == 1 ? strings.t("drawer.linksOne") : strings.t("drawer.links", ["count": "\(row.links)"]))" : row.title))
    .accessibilityHint(Text(verbatim: row.folder ? strings.t(open ? "drawer.closeFolder" : "drawer.openFolder", ["title": row.title]) : ""))
    .accessibilityIdentifier("drawer-row-\(row.id)")
  }
}

/// Where a drawer row moves to: the space's folders, the one it's in ticked. A folder can't go inside itself.
private struct DrawerMoveSheet: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  let row: BookmarkTreeRow
  let from: String
  let onMove: (String) -> Void

  var body: some View {
    let title = strings.t("drawer.moveTitle")
    PanelSheet(title: title, testID: "drawer-move", words: strings.sheetWords(title), onClose: { onMove(from) }) {
      RowGroup {
        ForEach(Array(targets.enumerated()), id: \.element.id) { index, choice in
          if index > 0 { RowDivider() }
          let top = choice.id == bookmarksRoot
          ActionRow(
            top ? strings.t("save.topOfList") : choice.title, testID: "drawer-move-\(choice.id)", icon: top ? .bookmark : .folder,
            selected: choice.id == from
          ) { onMove(choice.id) }
          .padding(.leading, CGFloat(max(0, Int(choice.depth) - 1)) * Space.lg)
        }
      }
    }
  }

  /// The space's folders, less the row itself and what's inside it when it's a folder.
  private var targets: [BookmarkFolderChoice] {
    var inside: UInt32?
    return app.store.bookmarkFolders(spaceId: app.activeSpaceId).filter { choice in
      if let depth = inside {
        if choice.depth > depth { return false }
        inside = nil
      }
      if choice.id == row.id {
        inside = choice.depth
        return false
      }
      return true
    }
  }
}
