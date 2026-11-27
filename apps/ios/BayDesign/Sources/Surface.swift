import SwiftUI

extension View {
  /// Puts Bay's floating surface behind the view: Liquid Glass on iOS 26, a thin material before it.
  public func baySurface(radius: CGFloat) -> some View {
    modifier(SurfaceModifier(radius: radius))
  }

  /// Puts a capsule of glass (iOS 26) or material behind the view.
  public func bayCapsule() -> some View {
    modifier(CapsuleSurfaceModifier())
  }
}

struct SurfaceModifier: ViewModifier {
  let radius: CGFloat

  func body(content: Content) -> some View {
    if #available(iOS 26, *) {
      content.glassEffect(.regular.tint(themeTint), in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    } else {
      content.background(.regularMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
  }
}

struct CapsuleSurfaceModifier: ViewModifier {
  func body(content: Content) -> some View {
    if #available(iOS 26, *) {
      content.glassEffect(.regular.tint(themeTint), in: Capsule())
    } else {
      content.background(.regularMaterial, in: Capsule())
    }
  }
}

/// Liquid Glass takes its light or dark from what's behind it, so over a white page in dark mode it went pale grey under
/// white icons. Tinted with the theme's surface it keeps the theme on any page, still letting a little of the page through.
private let themeTint = BayColor.surface.opacity(0.7)
