import ImageIO
import SwiftUI
import UIKit

/// Pictures from the app's files (tab snapshots, site icons), decoded once at about the size they're drawn and kept in
/// memory. `UIImage(contentsOfFile:)` in a view's body read the file on the main thread on every update and decoded it
/// at full size when it was first drawn, once per card each time the switcher opened. A file is never rewritten under
/// its name (each snapshot gets a new one), so the path and size are the key.
enum FileImages {
  private nonisolated(unsafe) static let cache: NSCache<NSString, UIImage> = {
    let cache = NSCache<NSString, UIImage>()
    cache.totalCostLimit = 32 * 1024 * 1024
    return cache
  }()

  /// The picture if it's in memory already.
  static func cached(_ path: String, pixels: Int) -> UIImage? {
    cache.object(forKey: key(path, pixels))
  }

  /// The picture, decoded on a background thread the first time.
  static func load(_ path: String, pixels: Int) async -> UIImage? {
    if let image = cached(path, pixels: pixels) { return image }
    let image = await Task.detached(priority: .userInitiated) { decode(path, pixels: pixels) }.value
    if let image { store(image, path, pixels) }
    return image
  }

  /// The picture now, decoded on this thread the first time: for one that must be on screen in this frame.
  static func now(_ path: String, pixels: Int) -> UIImage? {
    if let image = cached(path, pixels: pixels) { return image }
    let image = decode(path, pixels: pixels)
    if let image { store(image, path, pixels) }
    return image
  }

  private static func key(_ path: String, _ pixels: Int) -> NSString { "\(path)@\(pixels)" as NSString }

  private static func store(_ image: UIImage, _ path: String, _ pixels: Int) {
    let bytes = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
    cache.setObject(image, forKey: key(path, pixels), cost: bytes)
  }

  /// Decoded in full now (so drawing it decodes nothing), at most `pixels` on its longer side.
  private nonisolated static func decode(_ path: String, pixels: Int) -> UIImage? {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary)
    else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: max(pixels, 1),
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
    return UIImage(cgImage: image)
  }
}

/// A picture from a file address, drawn once it's decoded (from memory at once after the first time); `placeholder`
/// until then, usually for a frame, and with `true` when the file can't be read.
struct FileImage<Content: View, Placeholder: View>: View {
  let uri: String?
  /// The longer side it's drawn at, in points.
  let points: CGFloat
  @ViewBuilder let content: (Image) -> Content
  @ViewBuilder let placeholder: (_ failed: Bool) -> Placeholder
  @Environment(\.displayScale) private var scale
  @State private var loaded: (path: String, image: UIImage?)?

  var body: some View {
    let path = uri.flatMap(URL.init(string:))?.path
    let pixels = Int((points * scale).rounded(.up))
    Group {
      if let path, let image = loaded?.path == path ? loaded?.image : FileImages.cached(path, pixels: pixels) {
        content(Image(uiImage: image))
      } else {
        placeholder(path == nil || (loaded?.path == path && loaded?.image == nil))
      }
    }
    .task(id: "\(path ?? "")@\(pixels)") {
      guard let path, FileImages.cached(path, pixels: pixels) == nil else { return }
      loaded = (path, await FileImages.load(path, pixels: pixels))
    }
  }
}
