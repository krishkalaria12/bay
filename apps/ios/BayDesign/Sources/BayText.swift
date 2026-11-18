import SwiftUI
import UIKit

/// What the text is for, which picks its colour from the theme.
public enum TextTone: Sendable {
  case `default`, muted, accent, danger

  var color: Color {
    switch self {
    case .default: return BayColor.foreground
    case .muted: return BayColor.muted
    case .accent: return BayColor.accent
    case .danger: return BayColor.danger
    }
  }
}

extension TextVariant {
  /// San Francisco at this step, following the phone's text size up to the step's limit.
  public func font(weight: Font.Weight? = nil, sizeCategory: DynamicTypeSize = .large) -> Font {
    .system(size: scaledSize(sizeCategory), weight: weight ?? self.weight)
  }

  /// The step's size at the phone's text size, capped where labels in fixed shapes would spill out.
  public func scaledSize(_ sizeCategory: DynamicTypeSize) -> CGFloat {
    let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(sizeCategory))
    let scaled = UIFontMetrics.default.scaledValue(for: size, compatibleWith: traits)
    return min(scaled, size * maxScale)
  }

  /// The extra space between lines that gives the step its line height.
  func lineSpacing(_ sizeCategory: DynamicTypeSize) -> CGFloat {
    let scaledSize = scaledSize(sizeCategory)
    let natural = UIFont.systemFont(ofSize: scaledSize).lineHeight
    return max(0, lineHeight * scaledSize / size - natural)
  }
}

extension UIContentSizeCategory {
  init(_ size: DynamicTypeSize) {
    switch size {
    case .xSmall: self = .extraSmall
    case .small: self = .small
    case .medium: self = .medium
    case .large: self = .large
    case .xLarge: self = .extraLarge
    case .xxLarge: self = .extraExtraLarge
    case .xxxLarge: self = .extraExtraExtraLarge
    case .accessibility1: self = .accessibilityMedium
    case .accessibility2: self = .accessibilityLarge
    case .accessibility3: self = .accessibilityExtraLarge
    case .accessibility4: self = .accessibilityExtraExtraLarge
    case .accessibility5: self = .accessibilityExtraExtraExtraLarge
    @unknown default: self = .large
    }
  }
}

/// Every piece of text in Bay: one type scale, in San Francisco.
public struct BayText: View {
  private let text: Text
  private let variant: TextVariant
  private let weight: Font.Weight?
  private let color: Color
  @Environment(\.dynamicTypeSize) private var sizeCategory

  /// Text to show as written (`verbatim`: never a localization key, never a link).
  public init(_ text: String, variant: TextVariant = .body, weight: Font.Weight? = nil, tone: TextTone = .default, color: Color? = nil) {
    self.text = Text(verbatim: text)
    self.variant = variant
    self.weight = weight
    self.color = color ?? tone.color
  }

  public var body: some View {
    text
      .font(variant.font(weight: weight, sizeCategory: sizeCategory))
      .lineSpacing(variant.lineSpacing(sizeCategory))
      .foregroundColor(color)
  }
}
