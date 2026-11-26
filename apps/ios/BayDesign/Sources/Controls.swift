import SwiftUI
import UIKit

/// How far a held control shrinks, and how much it dims.
private let heldScale: CGFloat = 0.04
private let heldDim: Double = 0.12

/// The press feedback every tile and row shares: the control shrinks a little and dims while held, then eases back.
/// With reduced motion only the dim stays.
public struct PressFeedbackStyle: ButtonStyle {
  @Environment(\.accessibilityReduceMotion) private var reduced

  public init() {}

  public func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .contentShape(Rectangle())
      .opacity(configuration.isPressed ? 1 - heldDim : 1)
      .scaleEffect(configuration.isPressed && !reduced ? 1 - heldScale : 1)
      .animation(Motion.tapAnimation(reduced: reduced), value: configuration.isPressed)
  }
}

extension ButtonStyle where Self == PressFeedbackStyle {
  /// Bay's press feedback for tiles and rows.
  public static var pressFeedback: PressFeedbackStyle { PressFeedbackStyle() }
}

/// A short text action ("Open", "Cancel"): a glass capsule on iOS 26, a material one before it.
public struct PillButton: View {
  private let label: String
  private let compact: Bool
  private let action: () -> Void

  public init(_ label: String, compact: Bool = false, action: @escaping () -> Void) {
    self.label = label
    self.compact = compact
    self.action = action
  }

  public var body: some View {
    if #available(iOS 26, *) {
      Button(action: action) { Text(verbatim: label) }
        .buttonStyle(.glass)
        .controlSize(compact ? .small : .regular)
    } else {
      Button(action: action) {
        BayText(label, variant: .subhead)
          .padding(.horizontal, compact ? Space.md : Space.lg)
          .frame(minHeight: 44)
          .bayCapsule()
      }
      .buttonStyle(.pressFeedback)
    }
  }
}

/// A round icon button in the bar: glass on iOS 26 (prominent in `tint` when given), material before it.
public struct GlassIconButton: View {
  private let icon: BayIcon
  private let label: String
  private let tint: Color?
  private let action: () -> Void

  /// The symbol's box: as tall as the search capsule's text line, so every button stands as tall as the capsule.
  private static let symbolBox: CGFloat = 20

  public init(_ icon: BayIcon, label: String, tint: Color? = nil, action: @escaping () -> Void) {
    self.icon = icon
    self.label = label
    self.tint = tint
    self.action = action
  }

  public var body: some View {
    let symbol = Image(systemName: icon.symbol)
      .font(.system(size: 17, weight: .medium))
      .frame(width: Self.symbolBox, height: Self.symbolBox)
    if #available(iOS 26, *) {
      if let tint {
        Button(action: action) { symbol }
          .buttonStyle(.glassProminent)
          .tint(tint)
          .buttonBorderShape(.circle)
          .controlSize(.large)
          .accessibilityLabel(Text(verbatim: label))
      } else {
        Button(action: action) { symbol }
          .buttonStyle(.glass)
          .buttonBorderShape(.circle)
          .controlSize(.large)
          .accessibilityLabel(Text(verbatim: label))
      }
    } else {
      Button(action: action) {
        symbol
          .foregroundColor(tint == nil ? BayColor.foreground : BayColor.accentForeground)
          .frame(width: 48, height: 48)
          .background(tint.map { AnyShapeStyle($0) } ?? AnyShapeStyle(.regularMaterial), in: Circle())
      }
      .buttonStyle(.pressFeedback)
      .accessibilityLabel(Text(verbatim: label))
    }
  }
}

/// The system switch, tinted with Bay's accent rather than green. The row around it handles the tap and tells
/// VoiceOver it is a switch, so the switch itself stays out of the reader.
public struct BayToggle: View {
  private let isOn: Bool

  public init(isOn: Bool) {
    self.isOn = isOn
  }

  public var body: some View {
    Toggle("", isOn: .constant(isOn))
      .labelsHidden()
      .tint(BayColor.accent)
      .allowsHitTesting(false)
      .accessibilityHidden(true)
  }
}

/// Bay's haptics.
public enum Haptics {
  /// One light tick, for a committed action: closing a tab, pinning a site, opening the link menu.
  public static func tick() {
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
  }

  /// A softer click, for a tap that only moves something on screen.
  public static func press() {
    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
  }

  /// A confirmation, for an action that finished: a link sent, a file saved.
  public static func done() {
    UINotificationFeedbackGenerator().notificationOccurred(.success)
  }
}
