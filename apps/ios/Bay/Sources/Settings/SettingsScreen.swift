import BayCore
import BayDesign
import SwiftUI

/// Settings, the whole screen: the index (a search field over cards of coloured tiles) and the pages pushed over it,
/// each written by the core. Its head holds one round button (× on the index, ‹ on a page) and the title.
struct SettingsScreen: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var settings: SettingsModel

  var body: some View {
    let context = settings.context
    ZStack(alignment: .top) {
      BayColor.background.ignoresSafeArea()
      if let page = settings.stack.last {
        SettingsPageView(settings: settings, view: settingsPage(page: page, ctx: context))
          .id(settings.stack.count)
          .transition(.move(edge: .trailing))
      } else {
        SettingsIndex(settings: settings, context: context).transition(.move(edge: .leading))
      }
      head
    }
    .animation(.easeOut(duration: 0.3), value: settings.stack.count)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("settings-screen")
  }

  private var head: some View {
    HStack {
      let back = !settings.stack.isEmpty
      SheetIconButton(back ? .back : .close, label: back ? strings.t("sheet.back") : strings.t("sheet.close", ["title": strings.t("settings.title")]), tone: .default) {
        if back { settings.pop() } else { settings.close() }
      }
      .accessibilityIdentifier(back ? "settings-screen-back" : "settings-screen-close")
      Spacer()
    }
    .overlay {
      if settings.stack.isEmpty { BayText(strings.t("settings.title"), variant: .headline).accessibilityAddTraits(.isHeader) }
    }
    .padding(.horizontal, Space.md)
    .frame(height: 52)
    .background(BayColor.background.opacity(0.96).ignoresSafeArea(edges: .top))
  }
}

/// The index: the search field, then the cards of entries, or what the search found.
private struct SettingsIndex: View {
  @EnvironmentObject private var strings: Strings
  @ObservedObject var settings: SettingsModel
  let context: SettingsContext
  @State private var query = ""

  var body: some View {
    ScrollView {
      VStack(spacing: Space.section) {
        searchField
        if query.trimmingCharacters(in: .whitespaces).isEmpty {
          ForEach(Array(settingsIndex(ctx: context, counts: settings.counts).enumerated()), id: \.offset) { _, group in
            IndexCard {
              ForEach(Array(group.enumerated()), id: \.offset) { index, row in
                if index > 0 { RowDivider(afterIcon: true) }
                IndexEntryRow(tile: row.tile, title: row.title, detail: row.value, testID: "settings-\(row.id)") { settings.open(row.entry) }
              }
            }
          }
        } else {
          let matches = settingsSearch(query: query, ctx: context)
          if matches.isEmpty {
            BayText(strings.t("settings.search.empty"), tone: .muted).padding(.vertical, Space.md)
              .accessibilityIdentifier("settings-search-empty")
          } else {
            IndexCard {
              ForEach(Array(matches.enumerated()), id: \.offset) { index, match in
                if index > 0 { RowDivider(afterIcon: true) }
                let row = settingsIndex(ctx: context, counts: settings.counts).flatMap { $0 }.first { $0.entry == match.entry }
                IndexEntryRow(
                  tile: row?.tile ?? SettingsTile(icon: "settings", tint: nil), title: row?.title ?? "", detail: match.detail,
                  testID: "settings-result-\(match.id)"
                ) { settings.open(match.entry, match: match) }
              }
            }
            .accessibilityIdentifier("settings-search-results")
          }
        }
      }
      .padding(.horizontal, Space.gutter)
      .padding(.top, 52 + Space.sm)
      .padding(.bottom, 40)
    }
    .accessibilityIdentifier("settings-index")
  }

  private var searchField: some View {
    HStack(spacing: Space.sm) {
      BayIconView(.search, size: IconSize.small, color: BayColor.muted)
      TextField(strings.t("settings.search.placeholder"), text: $query)
        .textInputAutocapitalization(.never)
        .disableAutocorrection(true)
        .submitLabel(.search)
        .accessibilityIdentifier("settings-search-field")
      if !query.isEmpty {
        Button { query = "" } label: {
          BayIconView(.close, size: IconSize.inline).frame(width: 24, height: 24).background(BayColor.foreground.opacity(0.15), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: strings.t("settings.search.clear")))
        .accessibilityIdentifier("settings-search-clear")
      }
    }
    .padding(.horizontal, 14)
    .frame(minHeight: 44)
    .background(BayColor.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
  }
}

/// A card of index rows.
private struct IndexCard<Content: View>: View {
  @ViewBuilder let content: () -> Content

  var body: some View {
    VStack(spacing: 0) { content() }
      .padding(.vertical, Space.xs)
      .background(BayColor.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
  }
}

/// An index entry's tile: a white glyph on its colour, or Bay's own mark.
struct SettingsTileView: View {
  let tile: SettingsTile
  var size: CGFloat = 30

  var body: some View {
    Group {
      if tile.icon == "mark", let mark = UIImage(named: "bay-mark") {
        Image(uiImage: mark).resizable().frame(width: size, height: size)
      } else {
        BayIconView(BayIcon(name: tile.icon) ?? .settings, size: (size * 0.58).rounded(), color: .white)
          .frame(width: size, height: size)
          .background(tile.tint.map(hexColor) ?? BayColor.muted)
      }
    }
    .clipShape(RoundedRectangle(cornerRadius: (size * 0.26).rounded(), style: .continuous))
    .accessibilityHidden(true)
  }
}

/// A colour written as `#RRGGBB`.
func hexColor(_ hex: String) -> Color {
  let value = UInt32(hex.dropFirst(), radix: 16) ?? 0
  return Color(RGBA(Double((value >> 16) & 255), Double((value >> 8) & 255), Double(value & 255)))
}

/// A row of the index: the entry's tile, its name, and what it is set to under the name.
private struct IndexEntryRow: View {
  let tile: SettingsTile
  let title: String
  let detail: String?
  let testID: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: Space.md) {
        SettingsTileView(tile: tile)
        VStack(alignment: .leading, spacing: 0) {
          BayText(title)
          if let detail { BayText(detail, variant: .footnote, tone: .muted).lineLimit(1) }
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, Space.md)
      .padding(.vertical, 5)
      .frame(minHeight: 50)
      .contentShape(Rectangle())
    }
    .buttonStyle(.pressFeedback)
    .accessibilityLabel(Text(verbatim: title))
    .accessibilityValue(Text(verbatim: detail ?? ""))
    .accessibilityIdentifier(testID)
  }
}

/// A page: its header (tile, name, one line), its sections of rows, and what it draws itself.
private struct SettingsPageView: View {
  @EnvironmentObject private var strings: Strings
  @ObservedObject var settings: SettingsModel
  let view: SettingsPageView_

  var body: some View {
    ScrollViewReader { reader in
      ScrollView {
        VStack(spacing: 22) {
          VStack(spacing: Space.md) {
            if let tile = view.tile { SettingsTileView(tile: tile, size: 56) }
            BayText(view.title, variant: .title).multilineTextAlignment(.center).accessibilityAddTraits(.isHeader)
              .accessibilityIdentifier("settings-page-title")
            if let blurb = view.blurb {
              BayText(blurb, variant: .footnote, tone: .muted).multilineTextAlignment(.center).padding(.horizontal, Space.xl)
            }
          }
          .padding(.top, Space.xs)
          ForEach(view.sections, id: \.id) { section in
            SettingsSectionView(section: section, lit: settings.focus) { row in tap(row) }
          }
          if view.drawn { DrawnBody(settings: settings, page: view.page) }
        }
        .padding(.horizontal, Space.gutter)
        .padding(.top, 52)
        .padding(.bottom, 40)
      }
      .onAppear {
        guard let focus = settings.focus else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
          withAnimation { reader.scrollTo(focus, anchor: .center) }
          DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { settings.focus = nil }
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("settings-page-\(view.page)")
  }

  private func tap(_ row: SettingsRow) {
    switch row.kind {
    case .page(let page, _): settings.push([page])
    case .choice(_, let action), .action(let action): settings.perform(action)
    case .toggle(let on, let whenOn, let whenOff): settings.perform(on ? whenOff : whenOn)
    case .info: break
    }
  }
}

typealias SettingsPageView_ = BayCore.SettingsPageView

/// A section: its title in small capitals, the card of rows, the words under it.
struct SettingsSectionView: View {
  let section: SettingsSection
  var lit: String?
  let tap: (SettingsRow) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let title = section.title {
        BayText(title.uppercased(), variant: .caption, weight: .semibold, tone: .muted).padding(.horizontal, Space.sm)
          .accessibilityAddTraits(.isHeader)
      }
      if !section.rows.isEmpty {
        VStack(spacing: 0) {
          ForEach(Array(section.rows.enumerated()), id: \.element.id) { index, row in
            if index > 0 { RowDivider(afterIcon: row.icon != nil) }
            SettingsRowView(row: row, lit: lit == row.id) { tap(row) }.id(row.id)
          }
        }
        .background(BayColor.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
      }
      if let footer = section.footer {
        BayText(footer, variant: .footnote, tone: .muted).padding(.horizontal, Space.sm)
          .accessibilityIdentifier(section.footerTestId ?? "")
      }
    }
  }
}

/// One row as the core wrote it: a chevron, a tick, a switch, or nothing.
private struct SettingsRowView: View {
  let row: SettingsRow
  let lit: Bool
  let tap: () -> Void

  var body: some View {
    let (chevron, toggle, selected): (Bool, Bool?, Bool) = {
      switch row.kind {
      case .page(_, let checked): return (true, nil, checked)
      case .choice(let selected, _): return (false, nil, selected)
      case .toggle(let on, _, _): return (false, on, false)
      case .action, .info: return (false, nil, false)
      }
    }()
    let icon = row.icon.flatMap { $0 == "mark" ? nil : BayIcon(name: $0) }
    ActionRow(
      row.label, testID: row.testId, icon: icon, detail: row.detail, value: row.value, chevron: chevron, toggle: toggle,
      selected: selected, destructive: row.danger, disabled: row.disabled, action: tap
    )
    .background(lit ? BayColor.accent.opacity(0.15) : .clear)
  }
}
