import SwiftUI

/// An SF Symbol, centred in a `size` × `size` square, so the text beside any icon starts in the same place. Hidden
/// from VoiceOver: the control around it carries the label.
public struct BayIconView: View {
  private let icon: BayIcon
  private let size: CGFloat
  private let color: Color?
  private let weight: Font.Weight

  public init(_ icon: BayIcon, size: CGFloat = 24, color: Color? = nil, weight: Font.Weight = .regular) {
    self.icon = icon
    self.size = size
    self.color = color
    self.weight = weight
  }

  public var body: some View {
    Image(systemName: icon.symbol)
      .font(.system(size: size * 0.75, weight: weight))
      .foregroundColor(color ?? BayColor.foreground)
      .frame(width: size, height: size)
      .accessibilityHidden(true)
  }
}
