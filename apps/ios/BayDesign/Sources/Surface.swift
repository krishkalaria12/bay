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
      content.glassEffect(.regular, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    } else {
      content.background(.regularMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
  }
}

struct CapsuleSurfaceModifier: ViewModifier {
  func body(content: Content) -> some View {
    if #available(iOS 26, *) {
      content.glassEffect(.regular, in: Capsule())
    } else {
      content.background(.regularMaterial, in: Capsule())
    }
  }
}
