import BayCore
import BayDesign
import BayEngine
import SwiftUI
import UIKit

/// The search sheet's measures (U4): it sits on the keyboard, holding the field and four rows, so it never jumps
/// while typing.
enum SearchSheet {
  static let topInset: CGFloat = 16
  static let fieldHeight: CGFloat = 48
  static let rowsTopGap: CGFloat = 6
  static let rowHeight: CGFloat = 56
  static let visibleRows = 4
  static let bottomInset: CGFloat = 8
  static let cornerRadius: CGFloat = 38

  static func height(rows: Int = visibleRows) -> CGFloat {
    topInset + fieldHeight + rowsTopGap + CGFloat(rows) * rowHeight + bottomInset
  }

  /// With nothing to list: the field alone.
  static let bareHeight = topInset + fieldHeight + bottomInset + 4
}

/// Answers that follow typing, asked a moment after it stops with the latest kept: the engine's suggestions, or the
/// site's own results while the field shows its chip (IMDb's titles, Wikipedia's articles).
@MainActor
final class TypingFetch<Item>: ObservableObject {
  @Published private(set) var items: [Item] = []
  private var task: Task<Void, Never>?
  private let http: HttpClient

  /// How long typing has to pause before anything is asked.
  private static var delay: UInt64 { 120_000_000 }

  init(http: HttpClient) {
    self.http = http
  }

  /// Asks `url`, reading its answer with `parse`; no address (nothing typed, suggestions off) clears the answer.
  func request(_ url: String?, parse: @escaping @Sendable (String) -> [Item]) {
    task?.cancel()
    guard let url else {
      items = []
      return
    }
    task = Task { [http] in
      try? await Task.sleep(nanoseconds: Self.delay)
      guard !Task.isCancelled else { return }
      let request = HttpRequest(method: "GET", url: url, headers: [:], body: nil, followRedirects: true, timeoutMs: 4000)
      guard let response = try? await http.send(request: request), response.status == 200,
            let body = String(data: response.body, encoding: .utf8), !Task.isCancelled
      else { return }
      items = parse(body)
    }
  }

  func cancel() {
    task?.cancel()
  }
}

/// Whether white text reads better than black on a colour (0–255 channels): its relative luminance, as WCAG works it
/// out, is 0.4 or less.
func isDarkColor(red: Double, green: Double, blue: Double) -> Bool {
  func channel(_ c: Double) -> Double {
    let v = c / 255
    return v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue) <= 0.4
}

/// A site's chip colours: its own colour, and black or white on it, whichever reads.
struct ScopeColors {
  let fill: Color
  let ink: Color
  /// A light colour (Wikipedia's white) needs an edge to show on a light sheet.
  let light: Bool

  init?(hex: String?) {
    guard let hex, hex.count == 7, hex.hasPrefix("#"), let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
    let red = Double((value >> 16) & 0xFF), green = Double((value >> 8) & 0xFF), blue = Double(value & 0xFF)
    fill = Color(RGBA(red, green, blue))
    light = !isDarkColor(red: red, green: green, blue: blue)
    ink = light ? .black : .white
  }
}

/// The search card: a field that grows out of the bar's capsule, with the rows for what's typed, on the keyboard.
/// Typing a site's name offers it ("Search IMDb"); choosing it, or a space after its keyword ("yt "), turns the field
/// into the site's chip, and the rows become the site's own.
struct SearchCard: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @Environment(\.dynamicTypeSize) private var sizeCategory
  @ObservedObject var browser: BrowserModel
  @StateObject private var remote: TypingFetch<String>
  @StateObject private var siteResults: TypingFetch<Suggestion>
  @State private var query: String
  /// The site the field searches, shown as a chip at its start.
  @State private var scope: SearchScope?
  /// The chip has just arrived: the field shows the site's colour in full for a moment.
  @State private var flash = false
  @State private var shortcuts: [SearchScope] = []
  @State private var privately: Bool
  /// No inline completion over a prefilled address, or straight after deleting.
  @State private var suppressed: Bool
  @State private var dragged: CGFloat = 0
  @State private var grown = false
  @State private var listening = false
  @FocusState private var focused: Bool
  private let initialText: String

  init(browser: BrowserModel, initialText: String, privately: Bool) {
    self.browser = browser
    self.initialText = initialText
    _remote = StateObject(wrappedValue: TypingFetch(http: browser.app.http))
    _siteResults = StateObject(wrappedValue: TypingFetch(http: browser.app.http))
    _query = State(initialValue: initialText)
    _privately = State(initialValue: privately)
    _suppressed = State(initialValue: !initialText.isEmpty)
  }

  private var result: SuggestionResult {
    // Until the prefilled address is changed, the rows are the space's recent pages, as on an empty field: the address
    // alone matches little more than its own page.
    app.store.suggestions(
      query: untouched ? "" : query, remote: remote.items, currentUrl: initialText.isEmpty ? nil : initialText,
      now: Double(AppModel.now()))
  }

  private var rows: [Suggestion] {
    if let scope {
      return app.store.scopedSuggestions(scope: scope, query: query, results: siteResults.items, now: Double(AppModel.now()))
    }
    return result.items.filter {
      switch $0 {
      case .page, .search, .calc, .scope: return true
      default: return false
      }
    }
  }

  private var colors: ScopeColors? { ScopeColors(hex: scope?.color) }

  /// The field still holds the page's address it opened with.
  private var untouched: Bool { !initialText.isEmpty && query == initialText }

  private var showsShortcuts: Bool { scope == nil && query.isEmpty && !shortcuts.isEmpty }

  /// Nothing to list under the field (a new person, before typing): the sheet is just the field, on the keyboard.
  private func bare(_ rows: [Suggestion]) -> Bool {
    rows.isEmpty && !showsShortcuts && !privately && (query.isEmpty || untouched)
  }

  /// Search was opened over a page, not for a new tab.
  private var overPage: Bool { !browser.searchInNewTab && browser.hasPage }

  private var text: Color { privately ? Color(RGBA(0xF4, 0xF4, 0xF5)) : BayColor.foreground }
  private var secondary: Color { privately ? Color(RGBA(0xA1, 0xA1, 0xAA)) : BayColor.muted }

  var body: some View {
    let completion = suppressed || scope != nil ? "" : result.completion
    let rows = rows
    ZStack(alignment: .bottom) {
      // The page stays where it is, blurred and dimmed behind the sheet.
      if overPage {
        Rectangle().fill(.ultraThinMaterial).ignoresSafeArea().allowsHitTesting(false)
      }
      Color.black.opacity(0.2).ignoresSafeArea().allowsHitTesting(false)
      Color.clear.contentShape(Rectangle()).ignoresSafeArea()
        .onTapGesture(perform: dismiss)
        .accessibilityElement()
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(Text(verbatim: strings.t("search.close")))
        .accessibilityIdentifier("search-dismiss")
      VStack(spacing: 0) {
        field(completion: completion, rows: rows)
          .padding(.top, SearchSheet.topInset)
          .padding(.horizontal, Space.lg)
          .gesture(
            DragGesture()
              .onChanged { dragged = max(0, $0.translation.height) }
              .onEnded { value in
                if value.translation.height > 80 || value.predictedEndTranslation.height > 200 {
                  dismiss()
                } else {
                  withAnimation(Motion.settle.animation) { dragged = 0 }
                }
              })
        ScrollView(showsIndicators: false) {
          VStack(alignment: .leading, spacing: 0) {
            if privately {
              BayText(strings.t("search.privateNotice"), variant: .footnote, color: secondary)
                .padding(.leading, Space.lg).padding(.top, 2)
                .accessibilityIdentifier("private-notice")
            }
            if showsShortcuts {
              shortcutRow
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
              SuggestionRow(row: row, index: index, engineName: browser.engine.name, text: text, secondary: secondary) {
                choose(row)
              } fill: { fill($0) }
            }
          }
          .padding(.horizontal, Space.sm)
          .padding(.bottom, SearchSheet.bottomInset)
        }
        .padding(.top, SearchSheet.rowsTopGap)
      }
      .frame(height: bare(rows) ? SearchSheet.bareHeight : SearchSheet.height())
      .animation(Motion.settle.animation, value: bare(rows))
      .background(
        (privately ? Color(RGBA(0x17, 0x17, 0x17)) : BayColor.background)
          .clipShape(RoundedCornerShape(radius: SearchSheet.cornerRadius))
          .ignoresSafeArea(edges: .bottom)
      )
      .offset(y: dragged)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier(privately ? "search-card-private" : "search-sheet")
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("search-card")
    .onAppear {
      focused = true
      withAnimation(Motion.settle.animation) { grown = true }
      // A prefilled address starts selected, so typing replaces it (as in Safari and Lens).
      if !initialText.isEmpty {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
          UIApplication.shared.sendAction(#selector(UIResponder.selectAll(_:)), to: nil, from: nil, for: nil)
        }
      }
      // Opened from the widget's microphone: listening at once, as if the mic had been tapped.
      if browser.searchListening { listen() }
      shortcuts = app.store.scopeShortcuts(limit: UInt32(Self.shortcutPlaces))
    }
    .onChange(of: query) { next in
      // A space after a site's keyword or name ("yt ", "imdb ", "!w ") turns the field into its chip.
      if scope == nil, next.hasSuffix(" "), !next.dropLast().contains(" "), let found = app.store.searchScope(text: String(next.dropLast())) {
        enter(found)
        return
      }
      let enabled = app.preferences.searchSuggestions
      if let scope {
        siteResults.request(enabled ? scopeSuggestRequest(scope: scope, query: next) : nil) {
          parseScopeSuggestions(scope: scope, body: $0)
        }
      } else {
        remote.request(enabled ? suggestionsRequestUrl(engine: browser.engine, query: next) : nil) { parseSuggestionsBody(body: $0) }
      }
    }
    .onDisappear {
      remote.cancel()
      siteResults.cancel()
    }
  }

  /// How many sites the row under the empty field holds.
  private static let shortcutPlaces = 5

  /// The sites the field can search, before anything is typed: a tap brings the site's chip, holding opens the site.
  private var shortcutRow: some View {
    HStack(spacing: Space.sm) {
      ForEach(shortcuts, id: \.host) { site in
        Button {
          enter(site)
        } label: {
          SiteIcon(url: site.home, size: 26, bare: true)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(privately ? Color.white.opacity(0.1) : BayColor.fill, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressFeedback)
        .simultaneousGesture(LongPressGesture(minimumDuration: 0.45).onEnded { _ in
          Haptics.tick()
          open(.url(site.home))
        })
        .accessibilityLabel(Text(verbatim: strings.t("search.withEngine", ["engine": site.name])))
        .accessibilityHint(Text(verbatim: strings.t("search.shortcutHint")))
        .accessibilityIdentifier("search-shortcut-\(site.host)")
      }
      // Always five places, so one site's tile is as wide as five sites' tiles.
      ForEach(shortcuts.count..<Self.shortcutPlaces, id: \.self) { _ in
        Color.clear.frame(maxWidth: .infinity, minHeight: 44).accessibilityHidden(true)
      }
    }
    .padding(.horizontal, Space.sm)
    .padding(.vertical, Space.xs)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("search-shortcuts")
  }

  /// The site's chip at the field's start; tapping it goes back to searching everything.
  private func chip(_ scope: SearchScope) -> some View {
    let colors = colors
    // A light chip (or none) gets an edge, so it shows on a light field.
    let edged = colors?.light ?? true
    return Button(action: leave) {
      HStack(spacing: 6) {
        SiteIcon(url: scope.home, size: 18, bare: true)
        Text(verbatim: scope.name).font(.system(size: 15, weight: .semibold)).lineLimit(1)
      }
      .foregroundColor(colors?.ink ?? text)
      .padding(.leading, 8)
      .padding(.trailing, 12)
      .frame(height: 32)
      .background(colors?.fill ?? (privately ? Color.white.opacity(0.18) : BayColor.background), in: Capsule())
      .overlay(Capsule().stroke(Color.black.opacity(edged ? 0.1 : 0), lineWidth: 1))
    }
    .buttonStyle(.plain)
    .padding(.leading, 8)
    .accessibilityLabel(Text(verbatim: strings.t("search.leaveSite", ["name": scope.name])))
    .accessibilityIdentifier("scope-chip")
  }

  /// The field's background: the site's colour, in full as the chip arrives, then a light wash of it.
  private var fieldFill: Color {
    if let colors { return colors.fill.opacity(flash ? 0.85 : 0.2) }
    return privately ? Color.white.opacity(0.1) : BayColor.fill
  }

  private func enter(_ site: SearchScope) {
    Haptics.press()
    suppressed = true
    remote.cancel()
    flash = true
    withAnimation(Motion.settle.animation) {
      scope = site
      query = ""
    }
    focused = true
    withAnimation(.easeOut(duration: 0.6).delay(0.25)) { flash = false }
  }

  private func leave() {
    siteResults.cancel()
    withAnimation(Motion.settle.animation) { scope = nil }
    focused = true
  }

  private func choose(_ row: Suggestion) {
    switch row {
    case .scope(let site):
      enter(site)
    case .page(let url, _, _, nil, nil, _, _, let place?) where place.spaceId != app.activeSpaceId:
      // A bookmark from another space opens in that space.
      focused = false
      browser.selectSpace(place.spaceId)
      browser.open(.url(url), privately: privately)
    default:
      open(target(for: row))
    }
  }

  /// The mark before the words while the chip shows.
  private static let chipMark = "\u{200B}"

  /// The field's text: the words, after the chip's mark while there is a chip. A field emptied of the mark too (a
  /// backspace with nothing typed) leaves the site.
  private var fieldText: Binding<String> {
    Binding(
      get: { scope == nil ? query : Self.chipMark + query },
      set: { text in
        if scope != nil, text.isEmpty {
          leave()
          return
        }
        query = text.replacingOccurrences(of: Self.chipMark, with: "")
      })
  }

  private func field(completion: String, rows: [Suggestion]) -> some View {
    let placeholder = scope.map { strings.t("search.withEngine", ["engine": $0.name]) } ?? strings.t("search.placeholder")
    return HStack(spacing: 0) {
      if let scope {
        chip(scope).transition(.scale(scale: 0.6).combined(with: .opacity))
      }
      ZStack(alignment: .leading) {
        if !completion.isEmpty {
          Text(completionText(completion))
            .font(TextVariant.headline.font(weight: .regular, sizeCategory: sizeCategory))
            .lineLimit(1)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .accessibilityIdentifier("address-completion")
        }
        // The field holds an invisible mark before the words while the chip shows, the placeholder drawn over it: a
        // backspace with no words deletes the mark, which SwiftUI's field reports, and gives the chip back.
        if scope != nil, query.isEmpty {
          Text(verbatim: placeholder)
            .font(TextVariant.headline.font(weight: .regular, sizeCategory: sizeCategory))
            .foregroundColor(Color(UIColor.placeholderText))
            .lineLimit(1)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
        TextField(scope == nil ? placeholder : "", text: fieldText)
          .font(TextVariant.headline.font(weight: .regular, sizeCategory: sizeCategory))
          .foregroundColor(text)
          .keyboardType(.webSearch)
          .textInputAutocapitalization(.never)
          .disableAutocorrection(true)
          .submitLabel(.go)
          .focused($focused)
          .onSubmit { submit(completion: completion, rows: rows) }
          .onChange(of: query) { [query] next in
            // Deleting shows what's left without completing it again.
            suppressed = next.count < query.count
          }
          .accessibilityLabel(Text(verbatim: placeholder))
          .accessibilityIdentifier("address-input")
      }
      .padding(.leading, scope == nil ? Space.lg : Space.sm)
      // Clears the words first, then the chip.
      if !query.isEmpty || scope != nil {
        iconButton(.close, label: strings.t("search.clear"), color: secondary) {
          if query.isEmpty { leave() } else { fill("") }
        }
        .accessibilityIdentifier("clear-address")
      }
      iconButton(.mic, label: strings.t(listening ? "search.listening" : "search.voice"), color: listening ? text : secondary, size: IconSize.control) {
        listen()
      }
      .disabled(listening)
      .accessibilityIdentifier("voice-search")
      iconButton(.private, label: strings.t("search.private"), color: privately ? text : secondary, size: IconSize.control) {
        privately.toggle()
      }
      .accessibilityAddTraits(privately ? .isSelected : [])
      .accessibilityIdentifier("private-toggle")
    }
    .frame(height: SearchSheet.fieldHeight)
    .background(fieldFill, in: Capsule())
    .scaleEffect(x: grown ? 1 : 0.5, y: 1)
    .opacity(grown ? 1 : 0)
  }

  /// The typed text (invisible, under the field's own) and the completion after it, tinted as selected text is.
  private func completionText(_ completion: String) -> AttributedString {
    var typed = AttributedString(query)
    typed.foregroundColor = .clear
    var rest = AttributedString(completion)
    rest.foregroundColor = text
    rest.backgroundColor = privately ? Color.white.opacity(0.18) : Color(RGBA(10, 132, 255, 0.22))
    return typed + rest
  }

  private func iconButton(_ icon: BayIcon, label: String, color: Color, size: CGFloat = IconSize.row, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      BayIconView(icon, size: size, color: color).frame(width: 44, height: 44).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(Text(verbatim: label))
  }

  private func fill(_ text: String) {
    suppressed = true
    query = text
    focused = true
  }

  /// Voice search (B16): the engine listens once, and what it hears replaces the field, like a paste.
  private func listen() {
    guard !listening else { return }
    listening = true
    Task {
      let heard = await Engine.listen()
      listening = false
      if let heard { fill(heard) }
    }
  }

  private func dismiss() {
    focused = false
    browser.dismissSearch()
  }

  private func submit(completion: String, rows: [Suggestion]) {
    if let scope {
      open(.url(scopedSearchUrl(scope: scope, query: query, defaultEngineUrl: browser.engine.url)))
      return
    }
    if !completion.isEmpty, let first = rows.first {
      open(target(for: first))
      return
    }
    // A bang ("font !w") goes where its row says.
    if case .search(_, let url, let engine, false) = rows.first, engine != browser.engine.name, query.contains("!") {
      open(.url(url))
      return
    }
    if let url = addressFor(input: query, engine: browser.engine) { open(.url(url)) }
  }

  private func open(_ target: OpenTarget) {
    focused = false
    browser.open(target, privately: privately)
  }

  private func target(for row: Suggestion) -> OpenTarget {
    switch row {
    case .page(let url, _, _, let tabId, let cleanedId, _, _, _):
      if let tabId { return .tab(tabId) }
      if let cleanedId { return .archived(cleanedId) }
      return .url(url)
    case .search(_, let url, _, _): return .url(url)
    case .calc(_, _, let url): return .url(url)
    case .result(_, _, _, let url): return .url(url)
    case .scope(let site): return .url(site.home)
    case .emoji, .create: return .url("")
    }
  }
}

/// One suggestion: a page, a search or a sum, with a button that fills its text into the field.
private struct SuggestionRow: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  let row: Suggestion
  let index: Int
  let engineName: String
  let text: Color
  let secondary: Color
  let open: () -> Void
  let fill: (String) -> Void

  var body: some View {
    let (title, detail, fillText, url) = parts
    Button(action: open) {
      HStack(spacing: Space.md) {
        Group {
          if case .result(_, _, let image?, let link) = row, let address = URL(string: image) {
            AsyncImage(url: address) { picture in
              picture.resizable().scaledToFill()
            } placeholder: {
              SiteIcon(url: link)
            }
            .frame(width: 28, height: 40)
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
            .accessibilityHidden(true)
          } else if let url {
            SiteIcon(url: url)
          } else {
            BayIconView(.search, size: IconSize.row, color: secondary)
          }
        }
        .frame(width: 28)
        VStack(alignment: .leading, spacing: 0) {
          BayText(title, color: text).lineLimit(1)
          HStack(spacing: Space.xs) {
            if place != nil {
              BayIconView(.bookmarked, size: IconSize.inline, color: secondary)
            }
            BayText(detail, variant: .footnote, color: secondary).lineLimit(1)
          }
        }
        .padding(.vertical, 6)
        Spacer(minLength: 0)
        if let fillText {
          Button {
            fill(fillText)
          } label: {
            BayIconView(.fill, size: IconSize.small, color: secondary).frame(width: 44, height: 44).contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel(Text(verbatim: strings.t("search.fillIn", ["title": title])))
          .accessibilityIdentifier("suggestion-fill-\(index)")
        }
      }
      .padding(.leading, Space.sm)
      .frame(minHeight: SearchSheet.rowHeight)
      .contentShape(Rectangle())
    }
    .buttonStyle(.pressFeedback)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(Text(verbatim: "\(title), \(detail)"))
    .accessibilityIdentifier("suggestion-\(index)")
  }

  /// Where the row's page is saved as a bookmark: "Personal · Watchlist", or the space alone at its top level.
  private var place: String? {
    guard case .page(_, _, _, nil, _, _, _, let place?) = row else { return nil }
    let space = app.spaces.first { $0.id == place.spaceId }.map { spaceName($0, strings) } ?? ""
    return [space, place.folder].filter { !$0.isEmpty }.joined(separator: " · ")
  }

  private var parts: (String, String, String?, String?) {
    switch row {
    case .page(let url, let title, _, let tabId, _, _, _, _):
      let address = displayUrl(url: url)
      let detail = tabId == nil ? (place ?? address) : strings.t("search.switchToTab", ["address": address])
      return (title.isEmpty ? address : title, detail, url, url)
    case .search(let query, _, let engine, _):
      return (query, strings.t("search.withEngine", ["engine": engine.isEmpty ? engineName : engine]), query, nil)
    case .calc(let expression, let value, _):
      return ("= \(value)", expression, nil, nil)
    case .scope(let site):
      return (strings.t("search.withEngine", ["engine": site.name]), displayUrl(url: site.home), nil, site.home)
    case .result(let title, let detail, _, let url):
      return (title, detail.isEmpty ? displayUrl(url: url) : detail, nil, url)
    case .emoji(let value, let name): return (value, name, nil, nil)
    case .create(_, let title, _, let site): return (title, site, nil, nil)
    }
  }
}

/// A shape with only its top corners rounded, for sheets (iOS 15 has no UnevenRoundedRectangle).
struct RoundedCornerShape: Shape {
  let radius: CGFloat

  func path(in rect: CGRect) -> Path {
    Path(
      UIBezierPath(roundedRect: rect, byRoundingCorners: [.topLeft, .topRight], cornerRadii: CGSize(width: radius, height: radius)).cgPath)
  }
}
