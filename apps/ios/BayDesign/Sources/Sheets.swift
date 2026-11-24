import SwiftUI

/// The words a sheet's chrome needs, in the app's language (the design system has no catalog of its own).
public struct SheetWords: Sendable {
  public let close: String
  public let back: String
  public let selected: String

  public init(close: String, back: String, selected: String) {
    self.close = close
    self.back = back
    self.selected = selected
  }
}

/// A panel's content: a small title centred at the top (with a round back button on a sub-page), the sheet's own round
/// buttons on the right, and the rows below, scrolling when they're taller than the sheet. There's no close button: a
/// sheet closes by a tap outside it, a drag down, or VoiceOver's escape. The system draws the sheet itself, floating as
/// glass on iOS 26; `baySheet` sizes it to what it holds.
public struct PanelSheet<Content: View, Accessory: View>: View {
  private let title: String
  private let testID: String
  private let words: SheetWords
  private let onClose: () -> Void
  private let onBack: (() -> Void)?
  private let header: AnyView?
  private let accessory: Accessory
  private let content: Content

  /// `header` takes the title's place on the sheet's first page (the page menu's site, say).
  public init(
    title: String, testID: String, words: SheetWords, onClose: @escaping () -> Void, onBack: (() -> Void)? = nil,
    header: AnyView? = nil, @ViewBuilder accessory: () -> Accessory = { EmptyView() }, @ViewBuilder content: () -> Content
  ) {
    self.title = title
    self.testID = testID
    self.words = words
    self.onClose = onClose
    self.onBack = onBack
    self.header = header
    self.accessory = accessory()
    self.content = content()
  }

  public var body: some View {
    VStack(spacing: 0) {
      Group {
        if let header, onBack == nil {
          HStack(alignment: .top, spacing: Space.md) {
            header.frame(maxWidth: .infinity, alignment: .leading)
            accessory
          }
        } else {
          titleRow
        }
      }
      .padding(.horizontal, Space.gutter)
      .padding(.top, Space.lg)
      .padding(.bottom, Space.md)
      ScrollView {
        VStack(alignment: .leading, spacing: 0) { content }
          .padding(.horizontal, Space.gutter)
          .padding(.bottom, Space.gutter + Space.md)
          .background(GeometryReader { Color.clear.preference(key: SheetContentHeight.self, value: $0.size.height) })
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(testID)
  }

  /// The title centred over the sheet, the back button at its left and the sheet's own buttons at its right.
  private var titleRow: some View {
    ZStack {
      BayText(title, variant: .headline, weight: .semibold).lineLimit(1)
        .padding(.horizontal, 52)
        .accessibilityAddTraits(.isHeader)
      HStack(spacing: Space.sm) {
        if let onBack {
          SheetIconButton(.back, label: words.back, tone: .default, action: onBack)
            .accessibilityIdentifier("\(testID)-back")
        }
        Spacer(minLength: 0)
        accessory
      }
    }
    .frame(minHeight: 36)
  }
}

/// How tall a sheet's rows are, so the sheet can stand as tall as them.
public struct SheetContentHeight: PreferenceKey {
  public static let defaultValue: CGFloat = 0
  public static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// The header and grabber above a sheet's rows.
private let sheetChrome: CGFloat = 84
/// No sheet is shorter than this, however little it holds.
private let shortestSheet: CGFloat = 200

extension View {
  /// Presents `content` as a sheet that fits it, up to `maxFraction` of the screen (iOS 16+; full height on iOS 15).
  public func baySheet<Sheet: View>(isPresented: Binding<Bool>, maxFraction: CGFloat = 0.65, @ViewBuilder content: @escaping () -> Sheet) -> some View {
    sheet(isPresented: isPresented) { FittedSheet(maxFraction: maxFraction, content: content) }
  }
}

private struct FittedSheet<Content: View>: View {
  let maxFraction: CGFloat
  let content: () -> Content
  @State private var height: CGFloat = 0

  var body: some View {
    if #available(iOS 16, *) {
      let tallest = UIScreen.main.bounds.height * maxFraction
      let fitted = height > 0 ? min(max(height + sheetChrome, shortestSheet), tallest) : tallest
      content()
        .onPreferenceChange(SheetContentHeight.self) { height = $0 }
        .presentationDetents([.height(fitted)])
        .presentationDragIndicator(.visible)
    } else {
      content()
    }
  }
}

/// A round button in a sheet's header: close, back, or one of the sheet's own.
public struct SheetIconButton: View {
  public enum Tone: Sendable { case `default`, muted }
  private let icon: BayIcon
  private let label: String
  private let tone: Tone
  private let disabled: Bool
  private let action: () -> Void

  public init(_ icon: BayIcon, label: String, tone: Tone = .muted, disabled: Bool = false, action: @escaping () -> Void) {
    self.icon = icon
    self.label = label
    self.tone = tone
    self.disabled = disabled
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      BayIconView(icon, size: IconSize.small, color: tone == .muted ? BayColor.muted : BayColor.foreground)
        .frame(width: 36, height: 36)
        .background(BayColor.fill, in: Circle())
    }
    .buttonStyle(.pressFeedback)
    .disabled(disabled)
    .opacity(disabled ? 0.4 : 1)
    .accessibilityLabel(Text(verbatim: label))
  }
}

/// A section's heading: small and quiet, stepped in to the rows' inset over a group.
public struct SectionLabel: View {
  private let text: String
  private let inset: Bool

  public init(_ text: String, inset: Bool = false) {
    self.text = text
    self.inset = inset
  }

  public var body: some View {
    BayText(text, variant: .footnote, weight: .semibold, tone: .muted)
      .padding(.top, Space.section)
      .padding(.bottom, Space.sm)
      .padding(.horizontal, inset ? rowInset : 0)
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityAddTraits(.isHeader)
  }
}

/// A row's side padding inside a group, and the space between its icon and its text.
private let rowInset = Space.lg
private let rowGap: CGFloat = 14

/// Rows on one rounded card, split by hairlines.
public struct RowGroup<Content: View>: View {
  private let label: String?
  private let content: Content

  public init(_ label: String? = nil, @ViewBuilder content: () -> Content) {
    self.label = label
    self.content = content()
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let label { SectionLabel(label, inset: true) }
      VStack(spacing: 0) { content }
        .background(BayColor.fill)
        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
    }
  }
}

/// A hairline between grouped rows, starting where the rows' text does.
public struct RowDivider: View {
  private let afterIcon: Bool

  public init(afterIcon: Bool = true) {
    self.afterIcon = afterIcon
  }

  public var body: some View {
    Rectangle().fill(BayColor.foreground.opacity(0.1)).frame(height: 1 / UIScreen.main.scale)
      .padding(.leading, afterIcon ? rowInset + IconSize.control + rowGap : rowInset)
  }
}

/// One tappable row: an icon (or a tinted square), a label with a detail line, and its value, chevron, switch or check.
public struct ActionRow: View {
  private let label: String
  private let icon: BayIcon?
  private let tint: Color?
  private let detail: String?
  /// A short tag after the label ("Beta").
  private let badge: String?
  private let value: String?
  private let chevron: Bool
  private let toggle: Bool?
  private let selected: Bool
  private let destructive: Bool
  private let disabled: Bool
  private let testID: String
  /// Takes the icon's place: another app's initial, say.
  private let leading: AnyView?
  /// Its sides and the space after the icon: a card's by default, a list's own where it sits under list rows.
  private let inset: CGFloat
  private let gap: CGFloat
  private let action: () -> Void
  @Environment(\.dynamicTypeSize) private var sizeCategory

  public init(
    _ label: String, testID: String, icon: BayIcon? = nil, tint: Color? = nil, detail: String? = nil, badge: String? = nil, value: String? = nil,
    chevron: Bool = false, toggle: Bool? = nil, selected: Bool = false, destructive: Bool = false, disabled: Bool = false,
    leading: AnyView? = nil, inset: CGFloat? = nil, gap: CGFloat? = nil, action: @escaping () -> Void
  ) {
    self.leading = leading
    self.inset = inset ?? rowInset
    self.gap = gap ?? rowGap
    self.label = label
    self.testID = testID
    self.icon = icon
    self.tint = tint
    self.detail = detail
    self.badge = badge
    self.value = value
    self.chevron = chevron
    self.toggle = toggle
    self.selected = selected
    self.destructive = destructive
    self.disabled = disabled
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      HStack(spacing: gap) {
        if let leading {
          leading
        } else if let icon, let tint {
          BayIconView(icon, size: IconSize.small, color: .white)
            .frame(width: 29, height: 29)
            .background(tint, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        } else if let icon {
          BayIconView(icon, size: IconSize.control, color: destructive ? BayColor.danger : BayColor.foreground)
        }
        VStack(alignment: .leading, spacing: 1) {
          HStack(spacing: Space.sm) {
            BayText(label, tone: destructive ? .danger : .default)
            if let badge {
              BayText(badge, variant: .caption, weight: .semibold, tone: .muted)
                .padding(.horizontal, Space.sm)
                .padding(.vertical, 2)
                .background(BayColor.fill, in: Capsule())
            }
          }
          // At the largest text sizes the value goes under the name, which would have no room beside it.
          if let value, stacksValue { BayText(value, variant: .subhead, tone: .muted).accessibilityIdentifier("\(testID)-value") }
          if let detail { BayText(detail, variant: .subhead, tone: .muted).lineLimit(2) }
        }
        Spacer(minLength: 0)
        // Drawn again over the row, where tests can read it; this copy only holds its place.
        if let value, !stacksValue { valueText(value).hidden() }
        trailing
      }
      .padding(.horizontal, inset)
      .padding(.vertical, Space.md)
      .frame(minHeight: Row.height)
      .contentShape(Rectangle())
    }
    .buttonStyle(.pressFeedback)
    .disabled(disabled)
    .opacity(disabled ? 0.4 : 1)
    .accessibilityLabel(Text(verbatim: [label, badge].compactMap { $0 }.joined(separator: ", ")))
    .accessibilityValue(Text(verbatim: [value, detail].compactMap { $0 }.joined(separator: ", ")))
    .accessibilityAddTraits(selected || toggle == true ? .isSelected : [])
    .accessibilityIdentifier(testID)
    .overlay(alignment: .trailing) {
      // A button reads as one element, so the value it shows is its own element here, with its own identifier.
      if let value, !stacksValue {
        HStack(spacing: gap) {
          valueText(value).accessibilityIdentifier("\(testID)-value")
          trailing.hidden()
        }
        .padding(.horizontal, inset)
        .opacity(disabled ? 0.4 : 1)
        .allowsHitTesting(false)
      }
    }
  }

  private var stacksValue: Bool { sizeCategory.isAccessibilitySize }

  /// Beside the label, at most two fifths of the screen and on up to two lines, as Android has it: at its full width a
  /// long value ("Same as all websites (Original font)") squeezed the label into a letter a line.
  private func valueText(_ value: String) -> some View {
    BayText(value, variant: .subhead, tone: .muted)
      .lineLimit(2)
      .multilineTextAlignment(.trailing)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: UIScreen.main.bounds.width * 0.4, alignment: .trailing)
  }

  @ViewBuilder private var trailing: some View {
    if chevron { BayIconView(.chevron, size: IconSize.small, color: BayColor.muted) }
    if let toggle { BayToggle(isOn: toggle) }
    if selected { BayIconView(.tick, size: IconSize.row, color: BayColor.accent) }
  }
}
