import CoreText
import ExpoModulesCore
import SwiftUI
import UIKit

/// The welcome's name in Liquid Glass: the letters themselves are the glass, so what drifts behind them shows through,
/// bent. React Native lays the view out, handles the tap and squishes it; this only draws.
final class BayGlassNameView: ExpoView {
  private let host = UIHostingController(rootView: GlassName(text: "Bay."))

  var text = "Bay." {
    didSet { host.rootView = GlassName(text: text) }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    host.view.backgroundColor = .clear
    host.view.isUserInteractionEnabled = false
    addSubview(host.view)
    isAccessibilityElement = false
    accessibilityElementsHidden = true
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    host.view.frame = bounds
  }
}

private struct GlassName: View {
  let text: String

  var body: some View {
    let shape = NameShape(text: text)
    ZStack {
      // A soft shadow under the letters, so they stand off the ground.
      shape
        .fill(Color(red: 20 / 255, green: 28 / 255, blue: 54 / 255).opacity(0.16))
        .blur(radius: 10)
        .offset(y: 10)
      if #available(iOS 26.0, *) {
        Color.clear.glassEffect(.regular.tint(Color.white.opacity(0.3)), in: shape)
      } else {
        shape.fill(.ultraThinMaterial)
      }
    }
  }
}

/// The name as a shape: the system font's heaviest letters, kerned tight, fitted to the rect. After Yab's NameShape
/// (Phone/Sources/Welcome/FirstRun.swift, Apache-2.0).
private struct NameShape: Shape {
  let text: String

  func path(in rect: CGRect) -> Path {
    let glyphs = Self.glyphs(text)
    let unit = glyphs.boundingBoxOfPath
    guard unit.width > 0, unit.height > 0 else { return Path() }
    let k = min(rect.width / unit.width, rect.height / unit.height)
    let x = rect.midX - unit.midX * k
    let y = rect.midY - unit.midY * k
    return Path(glyphs).applying(CGAffineTransform(a: k, b: 0, c: 0, d: k, tx: x, ty: y))
  }

  private static var cache: [String: CGPath] = [:]

  private static func glyphs(_ text: String) -> CGPath {
    if let path = cache[text] { return path }
    let font = UIFont.systemFont(ofSize: 182, weight: .heavy)
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [.font: font, .kern: -7]))
    let path = CGMutablePath()
    for run in (CTLineGetGlyphRuns(line) as? [CTRun]) ?? [] {
      let count = CTRunGetGlyphCount(run)
      guard count > 0 else { continue }
      let attributes = CTRunGetAttributes(run) as NSDictionary
      // SAFETY: CoreText always puts the run's CTFont under this key.
      let runFont = attributes[kCTFontAttributeName as String].map { $0 as! CTFont } ?? (font as CTFont)
      var ids = [CGGlyph](repeating: 0, count: count)
      var points = [CGPoint](repeating: .zero, count: count)
      CTRunGetGlyphs(run, CFRange(location: 0, length: count), &ids)
      CTRunGetPositions(run, CFRange(location: 0, length: count), &points)
      for i in 0..<count {
        guard let glyph = CTFontCreatePathForGlyph(runFont, ids[i], nil) else { continue }
        // CoreText draws up from the baseline: flip it for the screen.
        path.addPath(glyph, transform: CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: points[i].x, ty: -points[i].y))
      }
    }
    cache[text] = path
    return path
  }
}
