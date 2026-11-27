import SwiftUI
import UIKit

/// An sRGB colour with alpha, as the tokens write them.
public struct RGBA: Sendable {
  public let red: Double, green: Double, blue: Double, alpha: Double

  public init(_ red: Double, _ green: Double, _ blue: Double, _ alpha: Double = 1) {
    self.red = red
    self.green = green
    self.blue = blue
    self.alpha = alpha
  }

  var uiColor: UIColor {
    UIColor(red: red / 255, green: green / 255, blue: blue / 255, alpha: alpha)
  }
}

extension Color {
  /// One colour, the same in light and dark mode.
  public init(_ rgba: RGBA) {
    self.init(uiColor: rgba.uiColor)
  }

  /// A colour that follows the appearance: `light` in light mode, `dark` in dark mode.
  public init(light: RGBA, dark: RGBA) {
    self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? dark.uiColor : light.uiColor })
  }
}

/// A spring by how long one period takes and how damped it is; 1 is critically damped (no overshoot).
public struct BaySpring: Sendable {
  public let response: Double
  public let dampingRatio: Double

  public init(response: Double, dampingRatio: Double) {
    self.response = response
    self.dampingRatio = dampingRatio
  }

  public var animation: Animation {
    .spring(response: response, dampingFraction: dampingRatio, blendDuration: 0)
  }
}

extension Motion {
  /// A tap: quick, and eased out. With reduced motion every animation is a short fade instead.
  public static func tapAnimation(reduced: Bool) -> Animation {
    reduced ? .easeOut(duration: 0.12) : .easeOut(duration: tap)
  }
}
