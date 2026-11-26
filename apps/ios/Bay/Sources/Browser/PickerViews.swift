import BayCore
import BayDesign
import SwiftUI

/// The element picker's card in the bar's place: what's picked, in words, with its tag and size, over its actions.
struct PickerCard: View {
  @EnvironmentObject private var strings: Strings
  @ObservedObject var browser: BrowserModel
  let mode: BrowserModel.PickMode

  var body: some View {
    let picked = browser.picked
    let hint = mode == .hide ? strings.t("picker.hideHint") : strings.t("picker.inspectHint")
    VStack(alignment: .leading, spacing: Space.md) {
      HStack(spacing: Space.md) {
        BayIconView(mode == .hide ? .hide : .inspect, size: IconSize.row, color: BayColor.accent)
          .frame(width: 40, height: 40)
          .background(BayColor.accent.opacity(0.15), in: Circle())
        VStack(alignment: .leading, spacing: 1) {
          BayText(picked?.label ?? hint, variant: .callout, weight: .medium).lineLimit(1)
            .accessibilityIdentifier(mode == .hide ? "hide-instructions" : "inspect-instructions")
          BayText(picked.map { "\($0.tag) · \($0.width) × \($0.height)" } ?? strings.t("picker.linksClosed"), variant: .footnote, tone: .muted)
            .lineLimit(1)
        }
        Spacer(minLength: 0)
      }
      HStack(spacing: Space.sm) {
        if mode == .hide {
          if picked != nil {
            ToolButton(id: "hide-parent", label: strings.t("picker.parent"), icon: .up, action: browser.pickParent)
            ToolButton(id: "hide-zap", label: strings.t("picker.hide"), primary: true, action: browser.hidePicked)
          } else {
            let none = browser.activeHidden.isEmpty
            ToolButton(id: "hide-undo", label: strings.t("picker.undo"), disabled: none, action: browser.undoHide)
            ToolButton(id: "hide-reset", label: strings.t("picker.resetSite"), disabled: none, action: browser.showHidden)
          }
          ToolButton(id: "hide-done", label: strings.t("picker.done"), action: browser.endPicking)
        } else {
          if picked != nil {
            ToolButton(id: "inspect-parent-pick", label: strings.t("picker.parent"), icon: .up, action: browser.pickParent)
            ToolButton(id: "inspect-open", label: strings.t("picker.details"), primary: true, action: browser.inspectPicked)
          }
          ToolButton(id: "inspect-done", label: strings.t("picker.done"), action: browser.endPicking)
        }
      }
    }
    .padding(14)
    .baySurface(radius: Radius.card)
    .accessibilityElement(children: .contain)
  }
}

private struct ToolButton: View {
  let id: String
  let label: String
  var icon: BayIcon?
  var primary = false
  var disabled = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        if let icon { BayIconView(icon, size: IconSize.small, color: primary ? BayColor.accentForeground : BayColor.foreground) }
        BayText(label, variant: .callout, weight: primary ? .semibold : .regular, color: primary ? BayColor.accentForeground : BayColor.foreground)
          .lineLimit(1)
      }
      .frame(maxWidth: .infinity, minHeight: 44)
      .padding(.horizontal, Space.md)
      .background(primary ? BayColor.accentFill : BayColor.fill, in: Capsule())
    }
    .buttonStyle(PressFeedbackStyle())
    .disabled(disabled)
    .opacity(disabled ? 0.4 : 1)
    .accessibilityIdentifier(id)
  }
}

/// What the picked element is: its font first, then size, colours and the CSS that matches.
struct InspectPanel: View {
  @EnvironmentObject private var strings: Strings
  @ObservedObject var browser: BrowserModel
  let element: InspectedElement

  var body: some View {
    let title = strings.t("inspect.title")
    let font = element.font
    PanelSheet(title: title, testID: "inspect-panel", words: strings.sheetWords(title), onClose: { browser.panel = nil }) {
      VStack(alignment: .leading, spacing: 0) {
        if let label = browser.picked?.label {
          BayText(label, variant: .headline).lineLimit(2).accessibilityAddTraits(.isHeader).padding(.bottom, Space.xs)
            .accessibilityIdentifier("inspect-title")
        }
        HStack(alignment: .firstTextBaseline, spacing: Space.md) {
          Text(verbatim: element.name).font(.system(size: TextVariant.subhead.size, design: .monospaced)).foregroundColor(BayColor.muted)
            .lineLimit(1)
            .accessibilityIdentifier("inspect-name")
          Spacer(minLength: 0)
          BayText("\(Int(element.width.rounded())) × \(Int(element.height.rounded()))", variant: .subhead, tone: .muted)
            .accessibilityIdentifier("inspect-size")
        }
        HStack(spacing: Space.sm) {
          PillButton(strings.t("inspect.parent"), action: browser.pickParent).accessibilityIdentifier("inspect-parent")
          PillButton(strings.t("inspect.copy"), action: browser.copyInspected).accessibilityIdentifier("inspect-copy")
        }
        .padding(.top, Space.md)
        SectionLabel(strings.t("inspect.font"))
        BayText(font.rendered, variant: .headline).accessibilityIdentifier("inspect-font")
        BayText(fontKind(font), variant: .subhead, tone: .muted).accessibilityIdentifier("inspect-font-kind")
        detail(strings.t("inspect.size"), "\(font.size) / \(font.lineHeight)")
        detail(strings.t("inspect.weight"), font.style == "normal" ? font.weight : "\(font.weight) \(font.style)")
        if font.letterSpacing != "normal" { detail(strings.t("inspect.spacing"), font.letterSpacing) }
        detail(strings.t("inspect.stack"), font.stack.joined(separator: ", "))
        if let source = font.source { detail(strings.t("inspect.file"), source) }
        SectionLabel(strings.t("inspect.colour"))
        HStack(spacing: Space.sm) {
          swatch(element.swatches.color)
          mono(element.color).accessibilityIdentifier("inspect-color")
          BayText(strings.t("inspect.on"), variant: .subhead, tone: .muted)
          swatch(element.swatches.background)
          mono(element.background)
        }
        if !element.rules.isEmpty { SectionLabel(strings.t("inspect.css")) }
        ForEach(Array(element.rules.enumerated()), id: \.offset) { _, rule in
          VStack(alignment: .leading, spacing: 2) {
            HStack {
              mono(rule.selector, size: TextVariant.caption.size, weight: .semibold).lineLimit(1)
              Spacer(minLength: Space.sm)
              if !rule.source.isEmpty { BayText(rule.source, variant: .caption, tone: .muted).lineLimit(1) }
            }
            ForEach(Array(rule.decls.enumerated()), id: \.offset) { _, decl in
              (Text(verbatim: "\(decl.property): ").foregroundColor(BayColor.muted) + Text(verbatim: "\(decl.value);"))
                .font(.system(size: TextVariant.caption.size, design: .monospaced))
                .foregroundColor(BayColor.foreground)
                .lineLimit(2)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(Space.md)
          .background(BayColor.fill, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
          .padding(.bottom, Space.sm)
        }
      }
    }
    // The sheet covers the bar, so the picker's card and its notices stay at the sheet's foot, as they were before it
    // opened.
    .safeAreaInset(edge: .bottom) {
      VStack(spacing: Space.md) {
        if let toast = browser.toast {
          ToastView(toast: toast, onDone: browser.dismissToast).id(toast.id)
        }
        if let mode = browser.picking {
          PickerCard(browser: browser, mode: mode)
        }
      }
      .padding(.horizontal, Space.edge)
      .padding(.bottom, Space.xs)
    }
  }

  /// Where the rendered font comes from, and why it isn't the page's first choice when it isn't.
  private func fontKind(_ font: InspectedFont) -> String {
    let origin = fontOrigin(font: font)
    let kind: String
    switch origin.kind {
    case .web: kind = strings.t("inspect.webFont")
    case .system: kind = strings.t("inspect.systemFont")
    case .installed: kind = strings.t("inspect.installedFont")
    }
    return origin.missing.map { strings.t("inspect.fontMissing", ["kind": kind, "first": $0]) } ?? kind
  }

  private func detail(_ label: String, _ value: String) -> some View {
    HStack(alignment: .top, spacing: Space.md) {
      BayText(label, variant: .subhead, tone: .muted).frame(width: 64, alignment: .leading)
      BayText(value, variant: .subhead).lineLimit(2)
      Spacer(minLength: 0)
    }
    .padding(.top, Space.xs)
  }

  private func mono(_ text: String, size: CGFloat = TextVariant.subhead.size, weight: Font.Weight = .regular) -> Text {
    Text(verbatim: text).font(.system(size: size, weight: weight, design: .monospaced)).foregroundColor(BayColor.foreground)
  }

  // The colour's value is written beside it, so VoiceOver skips the swatch.
  private func swatch(_ color: String) -> some View {
    RoundedRectangle(cornerRadius: 4).fill(cssColor(color)).frame(width: 16, height: 16)
      .overlay(RoundedRectangle(cornerRadius: 4).stroke(BayColor.foreground.opacity(0.15), lineWidth: 1))
      .accessibilityHidden(true)
  }
}

/// A swatch's colour from the inspector's sRGB value: `#rrggbb`, or `rgb()`/`rgba()`.
private func cssColor(_ value: String) -> Color {
  if value.hasPrefix("#"), value.count == 7 { return hexColor(value) }
  let numbers = value.components(separatedBy: CharacterSet(charactersIn: "0123456789.").inverted).compactMap(Double.init)
  guard numbers.count >= 3 else { return .clear }
  return Color(red: numbers[0] / 255, green: numbers[1] / 255, blue: numbers[2] / 255, opacity: numbers.count > 3 ? numbers[3] : 1)
}
