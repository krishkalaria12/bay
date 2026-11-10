import AppKit
import QuartzCore

/// The sidebar's Clear, as yab draws it: each cleared row breaks into its own pixels (its icon's colours, its title's),
/// which drift left, then scatter and fade, the row going from its left edge to its right.
enum Disintegrate {
  /// Specks a row may become, and in all (a screenful of rows).
  private static let perRow = 700
  private static let total = 4_000
  private static let speck: CGFloat = 0.8
  private static let duration: CFTimeInterval = 0.85
  /// How long the sweep takes from a row's left edge to its right.
  private static let sweep: CFTimeInterval = 0.22

  /// `rects`: the rows, in the window's content from its top-left (as React Native measures them).
  static func run(window: NSWindow, rects: [CGRect]) {
    guard let content = window.contentView, let root = content.layer, !rects.isEmpty else { return }
    let host = CALayer()
    host.frame = root.bounds
    host.zPosition = 10_000
    host.isGeometryFlipped = !content.isFlipped
    var longest: CFTimeInterval = 0
    let budget = max(80, min(perRow, total / rects.count))
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for rect in rects {
      for speck in specks(of: content, in: rect, limit: budget) {
        let layer = CALayer()
        layer.backgroundColor = speck.color
        layer.bounds = CGRect(x: 0, y: 0, width: speck.size, height: speck.size)
        layer.position = speck.point
        layer.opacity = 0
        host.addSublayer(layer)
        let delay = sweep * Double((speck.point.x - rect.minX) / max(rect.width, 1)) + .random(in: 0...0.06)
        let life = duration * .random(in: 0.75...1.1)
        animate(layer, from: speck.point, delay: delay, duration: life)
        longest = max(longest, delay + life)
      }
    }
    root.addSublayer(host)
    CATransaction.commit()
    DispatchQueue.main.asyncAfter(deadline: .now() + longest + 0.05) { host.removeFromSuperlayer() }
  }

  private struct Speck {
    let point: CGPoint
    let color: CGColor
    let size: CGFloat
  }

  /// The row's pixels that aren't its background, a point apart, at most `limit` of them (picked at random).
  private static func specks(of content: NSView, in rect: CGRect, limit: Int) -> [Speck] {
    // React Native's rect is from the top-left; AppKit's from the bottom-left unless the view is flipped.
    let local = content.isFlipped ? rect : CGRect(x: rect.minX, y: content.bounds.height - rect.maxY, width: rect.width, height: rect.height)
    guard let rep = content.bitmapImageRepForCachingDisplay(in: local) else { return [] }
    content.cacheDisplay(in: local, to: rep)
    let width = rep.pixelsWide, rows = rep.pixelsHigh
    guard width > 2, rows > 2 else { return [] }
    let scale = CGFloat(width) / rect.width
    // RGBA, 0–1, straight (not premultiplied): straight from the bytes when they're 8-bit RGBA, else through NSColor.
    let bytes = rep.bitmapData
    let direct = bytes != nil && rep.bitsPerSample == 8 && rep.samplesPerPixel == 4 && !rep.bitmapFormat.contains(.alphaFirst)
    let premultiplied = !rep.bitmapFormat.contains(.alphaNonpremultiplied)
    func pixel(_ x: Int, _ y: Int) -> (r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat) {
      if direct, let bytes {
        let i = y * rep.bytesPerRow + x * 4
        let a = CGFloat(bytes[i + 3]) / 255
        let k: CGFloat = premultiplied && a > 0 ? 1 / a : 1
        return (CGFloat(bytes[i]) / 255 * k, CGFloat(bytes[i + 1]) / 255 * k, CGFloat(bytes[i + 2]) / 255 * k, a)
      }
      let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) ?? .clear
      return (c.redComponent, c.greenComponent, c.blueComponent, c.alphaComponent)
    }
    // The background: what the row's ends show (its ink is in between).
    let bg = [pixel(1, rows / 2), pixel(width - 2, rows / 2), pixel(width / 2, 1)]
    func far(_ c: (r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat)) -> Bool {
      bg.allSatisfy { abs(c.r - $0.r) + abs(c.g - $0.g) + abs(c.b - $0.b) + abs(c.a - $0.a) > 0.28 }
    }
    let step = max(1, Int(scale.rounded()))
    var found: [Speck] = []
    for py in stride(from: 0, to: rows, by: step) {
      for px in stride(from: 0, to: width, by: step) {
        let c = pixel(px, py)
        guard c.a > 0.15, far(c) else { continue }
        // Rows from the top, as the rect's.
        let point = CGPoint(x: rect.minX + CGFloat(px) / scale, y: rect.minY + CGFloat(py) / scale)
        // As it shows: grey text is often black drawn see-through.
        let color = CGColor(srgbRed: min(1, c.r), green: min(1, c.g), blue: min(1, c.b), alpha: c.a)
        found.append(Speck(point: point, color: color, size: speck * .random(in: 0.75...1.4)))
      }
    }
    return found.count > limit ? Array(found.shuffled().prefix(limit)) : found
  }

  /// Off to the left first, as a clump, then out every way as it thins and fades.
  private static func animate(_ layer: CALayer, from start: CGPoint, delay: CFTimeInterval, duration: CFTimeInterval) {
    let drift = CGPoint(x: start.x - .random(in: 14...34), y: start.y + .random(in: -4...6))
    let end = CGPoint(x: drift.x + .random(in: -46...30), y: drift.y + .random(in: -42...42))
    let move = CAKeyframeAnimation(keyPath: "position")
    move.values = [start, drift, end].map { NSValue(point: $0) }
    move.keyTimes = [0, 0.4, 1]
    move.timingFunctions = [CAMediaTimingFunction(name: .easeIn), CAMediaTimingFunction(name: .easeOut)]
    let fade = CAKeyframeAnimation(keyPath: "opacity")
    fade.values = [1, 1, 0.75, 0]
    fade.keyTimes = [0, 0.35, 0.7, 1]
    let group = CAAnimationGroup()
    group.animations = [move, fade]
    group.beginTime = CACurrentMediaTime() + delay
    group.duration = duration
    group.fillMode = .both
    group.isRemovedOnCompletion = false
    layer.add(group, forKey: "disintegrate")
  }
}
