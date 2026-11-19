import BayCore
import BayDesign
import BayEngine
import SwiftUI

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

/// The space's bookmark tree a folder at a time, in the order it was saved. Search looks through every link, whichever
/// folder it's in. Removing a folder asks first, since it takes everything inside with it.
struct BookmarksPanel: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel
  @State private var folderId = "bookmarks"
  @State private var query = ""
  /// The folder whose remove button was tapped: its row asks before anything goes.
  @State private var confirming: String?

  var body: some View {
    let space = app.activeSpaceId
    let listing = app.store.bookmarkListing(spaceId: space, folderId: folderId, query: query)
    let atRoot = listing.parentId == nil
    let title = atRoot ? strings.t("bookmarks.title") : (listing.title.isEmpty ? strings.t("bookmarks.untitled") : listing.title)
    let needle = query.trimmingCharacters(in: .whitespaces)
    PanelSheet(
      title: title, testID: "bookmarks-screen", words: strings.sheetWords(title), onClose: { browser.panel = nil },
      onBack: listing.parentId.map { parent in { enter(parent) } }
    ) {
      if listing.nodes == 0 {
        EmptyNote(title: strings.t("bookmarks.empty"), detail: strings.t("bookmarks.emptyDetail"), testID: "bookmarks-empty")
        importRow
      } else {
        SheetSearchField(text: $query, placeholder: strings.t("bookmarks.search"), testID: "bookmarks-search")
        if listing.rows.isEmpty {
          NoMatches(
            text: needle.isEmpty ? strings.t("bookmarks.folderEmpty") : strings.t("bookmarks.noMatches", ["query": needle]),
            testID: "bookmarks-no-matches")
        }
        ForEach(listing.rows, id: \.node.id) { row in
          switch row.node {
          case .url(let id, _, let linkTitle, let url, _):
            let rowTitle = pageTitle(title: linkTitle, url: url)
            SiteRow(
              url: url, title: rowTitle, detail: siteName(url: url),
              openLabel: strings.t("history.openLabel", ["title": rowTitle]), removeLabel: strings.t("bookmarks.removeLabel", ["title": rowTitle]),
              testID: "bookmark-open-\(url)", removeTestID: "bookmark-remove-\(url)",
              onOpen: { browser.openListed(url) },
              onRemove: { app.dispatch(.removeBookmark(spaceId: space, id: id)) })
          case .folder(let id, _, let folderTitle, _, _):
            FolderRow(
              name: folderTitle.isEmpty ? strings.t("bookmarks.untitled") : folderTitle, links: row.links, confirming: confirming == id,
              onOpen: { enter(id) }, onAskRemove: { confirming = id },
              onRemove: {
                confirming = nil
                app.dispatch(.removeBookmark(spaceId: space, id: id))
              },
              onKeep: { confirming = nil })
          }
        }
        if atRoot && needle.isEmpty { importRow.padding(.top, Space.lg) }
      }
    }
  }

  /// The way to bring bookmarks from another browser, under the list's top.
  private var importRow: some View {
    ActionRow(strings.t("bookmarks.import"), testID: "bookmarks-import", icon: .import, chevron: true) { browser.panel = .import }
  }

  private func enter(_ id: String) {
    confirming = nil
    folderId = id
  }
}

extension BookmarkNode {
  fileprivate var id: String {
    switch self {
    case .url(let id, _, _, _, _), .folder(let id, _, _, _, _): return id
    }
  }
}

private struct FolderRow: View {
  @EnvironmentObject private var strings: Strings
  let name: String
  let links: UInt32
  let confirming: Bool
  let onOpen: () -> Void
  let onAskRemove: () -> Void
  let onRemove: () -> Void
  let onKeep: () -> Void

  var body: some View {
    let detail =
      links == 0
      ? strings.t("bookmarks.folderEmpty") : links == 1 ? strings.t("bookmarks.folderOne") : strings.t("bookmarks.folderCount", ["count": "\(links)"])
    if confirming {
      VStack(spacing: 0) {
        ActionRow(
          strings.t("bookmarks.removeFolder", ["title": name]), testID: "bookmark-folder-remove-confirm", icon: .delete, detail: detail,
          destructive: true, action: onRemove)
        ActionRow(strings.t("bookmarks.keep"), testID: "bookmark-folder-keep", action: onKeep)
      }
      .padding(.vertical, Space.sm)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("bookmark-folder-confirm-\(name)")
    } else {
      HStack(spacing: Space.md) {
        Button(action: onOpen) {
          HStack(spacing: Space.md) {
            BayIconView(.folder, size: IconSize.control, color: BayColor.accent).frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 0) {
              BayText(name, variant: .callout).lineLimit(1)
              BayText(detail, variant: .footnote, tone: .muted).lineLimit(1)
            }
            Spacer(minLength: 0)
            BayIconView(.chevron, size: IconSize.inline, color: BayColor.muted)
          }
          .padding(.vertical, Space.sm)
          .contentShape(Rectangle())
        }
        .buttonStyle(PressFeedbackStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: strings.t("bookmarks.openFolderLabel", ["title": name])))
        .accessibilityValue(Text(verbatim: detail))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("bookmark-folder-\(name)")
        RemoveButton(label: strings.t("bookmarks.removeLabel", ["title": name]), testID: "bookmark-folder-remove-\(name)", action: onAskRemove)
      }
      .frame(minHeight: 56)
      .overlay(alignment: .bottom) { Hairline() }
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
    browser.showTopNote(TopNote(text: strings.t("save.addedTo", ["place": place]), space: chosen) { [weak browser] in
      browser?.panel = .bookmarks
    })
  }
}
