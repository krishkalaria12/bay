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
}

/// The engine's suggestions for what's typed: asked a moment after typing stops, the latest answer kept.
@MainActor
final class RemoteSuggestions: ObservableObject {
  @Published private(set) var items: [String] = []
  private var task: Task<Void, Never>?
  private let http: HttpClient

  /// How long typing has to pause before the engine is asked.
  private static let delay: UInt64 = 120_000_000

  init(http: HttpClient) {
    self.http = http
  }

  func request(_ query: String, engine: SearchEngine, enabled: Bool) {
    task?.cancel()
    guard enabled, !query.trimmingCharacters(in: .whitespaces).isEmpty,
          let url = suggestionsRequestUrl(engine: engine, query: query)
    else {
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
      items = parseSuggestionsBody(body: body)
    }
  }

  func cancel() {
    task?.cancel()
  }
}

/// The search card: a field that grows out of the bar's capsule, with the rows for what's typed, on the keyboard.
struct SearchCard: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel
  @StateObject private var remote: RemoteSuggestions
  @State private var query: String
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
    _remote = StateObject(wrappedValue: RemoteSuggestions(http: browser.app.http))
    _query = State(initialValue: initialText)
    _privately = State(initialValue: privately)
    _suppressed = State(initialValue: !initialText.isEmpty)
  }

  private var result: SuggestionResult {
    app.store.suggestions(
      query: query, remote: remote.items, currentUrl: initialText.isEmpty ? nil : initialText,
      now: Double(AppModel.now()))
  }

  private var rows: [Suggestion] {
    result.items.filter {
      switch $0 {
      case .page, .search, .calc: return true
      default: return false
      }
    }
  }

  private var text: Color { privately ? Color(RGBA(0xF4, 0xF4, 0xF5)) : BayColor.foreground }
  private var secondary: Color { privately ? Color(RGBA(0xA1, 0xA1, 0xAA)) : BayColor.muted }

  var body: some View {
    let result = result
    let completion = suppressed ? "" : result.completion
    let rows = rows
    ZStack(alignment: .bottom) {
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
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
              SuggestionRow(row: row, index: index, engineName: browser.engine.name, text: text, secondary: secondary) {
                open(target(for: row))
              } fill: { fill($0) }
            }
          }
          .padding(.horizontal, Space.sm)
          .padding(.bottom, SearchSheet.bottomInset)
        }
        .padding(.top, SearchSheet.rowsTopGap)
      }
      .frame(height: SearchSheet.height())
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
    }
    .onChange(of: query) { remote.request($0, engine: browser.engine, enabled: app.preferences.searchSuggestions) }
    .onDisappear { remote.cancel() }
  }

  private func field(completion: String, rows: [Suggestion]) -> some View {
    HStack(spacing: 0) {
      ZStack(alignment: .leading) {
        if !completion.isEmpty {
          Text(completionText(completion))
            .font(TextVariant.headline.font(weight: .regular))
            .lineLimit(1)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .accessibilityIdentifier("address-completion")
        }
        TextField(strings.t("search.placeholder"), text: $query)
          .font(TextVariant.headline.font(weight: .regular))
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
          .accessibilityLabel(Text(verbatim: strings.t("search.placeholder")))
          .accessibilityIdentifier("address-input")
      }
      .padding(.leading, Space.lg)
      if !query.isEmpty {
        iconButton(.close, label: strings.t("search.clear"), color: secondary) { fill("") }
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
    .background(privately ? Color.white.opacity(0.1) : BayColor.fill, in: Capsule())
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
      BayIconView(icon, size: size, color: color).frame(width: 44, height: 44)
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
    if !completion.isEmpty, let first = rows.first {
      open(target(for: first))
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
    case .page(let url, _, _, let tabId, let cleanedId, _, _):
      if let tabId { return .tab(tabId) }
      if let cleanedId { return .archived(cleanedId) }
      return .url(url)
    case .search(_, let url, _, _): return .url(url)
    case .calc(_, _, let url): return .url(url)
    case .emoji, .create: return .url("")
    }
  }
}

/// One suggestion: a page, a search or a sum, with a button that fills its text into the field.
private struct SuggestionRow: View {
  @EnvironmentObject private var strings: Strings
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
          if let url {
            SiteIcon(url: url)
          } else {
            BayIconView(.search, size: IconSize.row, color: secondary)
          }
        }
        .frame(width: 28)
        VStack(alignment: .leading, spacing: 0) {
          BayText(title, color: text).lineLimit(1)
          BayText(detail, variant: .footnote, color: secondary).lineLimit(1)
        }
        .padding(.vertical, 6)
        Spacer(minLength: 0)
        if let fillText {
          Button {
            fill(fillText)
          } label: {
            BayIconView(.fill, size: IconSize.small, color: secondary).frame(width: 44, height: 44)
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

  private var parts: (String, String, String?, String?) {
    switch row {
    case .page(let url, let title, _, let tabId, _, _, _):
      let address = displayUrl(url: url)
      return (
        title.isEmpty ? address : title,
        tabId == nil ? address : strings.t("search.switchToTab", ["address": address]), url, url
      )
    case .search(let query, _, _, _):
      return (query, strings.t("search.withEngine", ["engine": engineName]), query, nil)
    case .calc(let expression, let value, _):
      return ("= \(value)", expression, nil, nil)
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
