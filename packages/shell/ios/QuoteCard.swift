import AppKit

// A quote is rendered locally. One pasteboard item carries both its picture and its source link.
enum QuoteCard {
  static let maximumLength = 4000

  struct Card {
    let image: NSImage
    let png: Data
    let url: URL
    let title: String

    func copy(to pasteboard: NSPasteboard = .general) -> Bool {
      let item = NSPasteboardItem()
      guard item.setData(png, forType: .png),
            let tiff = image.tiffRepresentation, item.setData(tiff, forType: .tiff),
            item.setString(url.absoluteString, forType: .URL),
            item.setString(url.absoluteString, forType: .string)
      else { return false }
      pasteboard.clearContents()
      return pasteboard.writeObjects([item])
    }
  }

  static func render(text: String, title: String, url: String, colors: [String], dark: Bool) -> Card? {
    let quote = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !quote.isEmpty, quote.count <= maximumLength,
          let source = URL(string: url), ["http", "https"].contains(source.scheme?.lowercased() ?? ""),
          let host = source.host, !host.isEmpty
    else { return nil }
    let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
    let name = title.isEmpty ? host : title
    let ink = dark ? NSColor.white : NSColor(white: 0.08, alpha: 1)
    let secondary = ink.withAlphaComponent(0.6)
    let width: CGFloat = 720, margin: CGFloat = 64, textWidth = width - margin * 2
    let fontSize: CGFloat = quote.count <= 220 ? 34 : quote.count <= 700 ? 28 : 24
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineSpacing = 6
    paragraph.paragraphSpacing = 12
    paragraph.lineBreakMode = .byWordWrapping
    let body = NSAttributedString(string: quote, attributes: [
      .font: NSFont.systemFont(ofSize: fontSize, weight: .medium), .foregroundColor: ink, .paragraphStyle: paragraph,
    ])
    // TextKit measures and draws the same glyphs, including RTL, emoji and unbroken words.
    let storage = NSTextStorage(attributedString: body)
    let layout = NSLayoutManager()
    let container = NSTextContainer(containerSize: NSSize(width: textWidth, height: .greatestFiniteMagnitude))
    container.lineFragmentPadding = 0
    storage.addLayoutManager(layout)
    layout.addTextContainer(container)
    let glyphs = layout.glyphRange(for: container)
    let quoteHeight = ceil(layout.usedRect(for: container).height)
    // Thousands of line breaks can be short in characters but enormous as an image.
    guard quoteHeight > 0, quoteHeight <= 6000 else { return nil }
    let quoteTop: CGFloat = 100
    let footerTop = quoteTop + quoteHeight + 32
    let size = NSSize(width: width, height: footerTop + 102)
    // Always 2x, independent of the display the window happens to be on.
    guard let bitmap = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: Int(size.width * 2), pixelsHigh: Int(size.height * 2), bitsPerSample: 8,
      samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
      let graphics = NSGraphicsContext(bitmapImageRep: bitmap)
    else { return nil }
    bitmap.size = size
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphics
    defer { NSGraphicsContext.restoreGraphicsState() }
    let cg = graphics.cgContext
    cg.scaleBy(x: 2, y: 2)
    cg.translateBy(x: 0, y: size.height)
    cg.scaleBy(x: 1, y: -1)
    NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)

    let backdrop = colors.prefix(8).compactMap { NSColor(hex: $0)?.usingColorSpace(.sRGB) }
    let stops = backdrop.isEmpty ? [NSColor(white: dark ? 0.22 : 0.85, alpha: 1)] : backdrop
    let gradient = NSGradient(colors: stops.count == 1 ? [stops[0], stops[0]] : stops)
    gradient?.draw(in: NSRect(origin: .zero, size: size), angle: 35)
    let panel = NSRect(x: 24, y: 24, width: width - 48, height: size.height - 48)
    let shape = NSBezierPath(roundedRect: panel, xRadius: 20, yRadius: 20)
    (dark ? NSColor(white: 0.08, alpha: 0.94) : NSColor(white: 1, alpha: 0.94)).setFill()
    shape.fill()
    ink.withAlphaComponent(0.1).setStroke()
    shape.lineWidth = 1
    shape.stroke()

    ("“" as NSString).draw(at: NSPoint(x: margin - 3, y: 39), withAttributes: [
      .font: NSFont.systemFont(ofSize: 58, weight: .semibold), .foregroundColor: secondary,
    ])
    layout.drawBackground(forGlyphRange: glyphs, at: NSPoint(x: margin, y: quoteTop))
    layout.drawGlyphs(forGlyphRange: glyphs, at: NSPoint(x: margin, y: quoteTop))
    let footer = NSMutableParagraphStyle()
    footer.lineBreakMode = .byTruncatingTail
    (name.replacingOccurrences(of: "\n", with: " ") as NSString).draw(
      in: NSRect(x: margin, y: footerTop, width: textWidth, height: 23),
      withAttributes: [.font: NSFont.systemFont(ofSize: 16, weight: .semibold), .foregroundColor: ink, .paragraphStyle: footer])
    (host as NSString).draw(
      in: NSRect(x: margin, y: footerTop + 29, width: textWidth - 50, height: 20),
      withAttributes: [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: secondary, .paragraphStyle: footer])
    ("Bay" as NSString).draw(
      in: NSRect(x: width - margin - 32, y: footerTop + 29, width: 32, height: 20),
      withAttributes: [.font: NSFont.systemFont(ofSize: 14, weight: .semibold), .foregroundColor: secondary])

    guard let png = bitmap.representation(using: .png, properties: [:]) else { return nil }
    let image = NSImage(size: size)
    image.addRepresentation(bitmap)
    return Card(image: image, png: png, url: source, title: name)
  }
}
