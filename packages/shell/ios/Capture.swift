import AppKit
import ExpoModulesCore
import ImageIO
import UniformTypeIdentifiers

// Capture's files and its Mark Up canvas (apps/browser components/capture). A capture is a PNG the engine wrote to the
// temporary folder (NNCoreWebView captureImage); these copy it, save it to Downloads, share it, and draw on it.
public class CaptureModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BayCapture")

    // The picture on the clipboard, as a copied image is: PNG and TIFF, for apps that read either.
    AsyncFunction("copyImage") { (path: String) -> Bool in
      guard let data = FileManager.default.contents(atPath: path), let image = NSImage(data: data) else { return false }
      let pasteboard = NSPasteboard.general
      pasteboard.clearContents()
      guard pasteboard.writeObjects([image]) else { return false }
      pasteboard.setData(data, forType: .png)
      return true
    }.runOnQueue(.main)

    // A copy in Downloads named `name` (a number after it when that's taken): its path.
    AsyncFunction("saveImage") { (path: String, name: String) -> String? in
      guard let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first else { return nil }
      let target = CaptureFiles.unique(in: downloads, name: name, ext: "png")
      do {
        try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: target)
        return target.path
      } catch {
        return nil
      }
    }.runOnQueue(.main)

    // The share menu for the picture (Messages, AirDrop, Mail…), under `anchor`: x, y, width, height in the window's
    // content, from its top-left.
    AsyncFunction("shareImage") { (path: String, name: String, windowId: String?, anchor: [Double]?) in
      CaptureFiles.share(path: path, name: name, windowId: windowId, anchor: anchor)
    }.runOnQueue(.main)

    View(CaptureCanvasView.self) {
      Events("onMarkupChange")
      Prop("path") { (view: CaptureCanvasView, path: String) in view.load(path) }
      Prop("tool") { (view: CaptureCanvasView, tool: String) in view.tool = CaptureCanvasView.Tool(rawValue: tool) ?? .pen }
      Prop("color") { (view: CaptureCanvasView, hex: String) in view.color = NSColor(hex: hex) ?? .systemRed }
      Prop("lineWidth") { (view: CaptureCanvasView, width: Double) in view.lineWidth = max(1, width) }
      AsyncFunction("undo") { (view: CaptureCanvasView) in view.undo(nil) }.runOnQueue(.main)
      AsyncFunction("redo") { (view: CaptureCanvasView) in view.redo(nil) }.runOnQueue(.main)
      AsyncFunction("clear") { (view: CaptureCanvasView) in view.clear() }.runOnQueue(.main)
      AsyncFunction("export") { (view: CaptureCanvasView) -> [String: Any]? in view.export() }.runOnQueue(.main)
    }
  }
}

enum CaptureFiles {
  private static var picker: NSSharingServicePicker?

  static func unique(in dir: URL, name: String, ext: String) -> URL {
    let base = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: ".")
    var url = dir.appendingPathComponent(base).appendingPathExtension(ext)
    var n = 2
    while FileManager.default.fileExists(atPath: url.path) {
      url = dir.appendingPathComponent("\(base) \(n)").appendingPathExtension(ext)
      n += 1
    }
    return url
  }

  static func share(path: String, name: String, windowId: String?, anchor: [Double]?) {
    let window = windowId.flatMap { WindowManager.shared.windows[$0] } ?? NSApp.keyWindow
    guard let view = window?.contentView, FileManager.default.fileExists(atPath: path) else { return }
    // Shared under its name, not the temporary file's.
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("Bay Shared Captures", isDirectory: true)
    try? FileManager.default.removeItem(at: dir)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = unique(in: dir, name: name, ext: "png")
    guard (try? FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: file)) != nil else { return }
    var rect = NSRect(x: view.bounds.midX - 1, y: 40, width: 2, height: 2)
    if let a = anchor, a.count == 4 { rect = NSRect(x: a[0], y: a[1], width: max(a[2], 1), height: max(a[3], 1)) }
    if !view.isFlipped { rect.origin.y = view.bounds.height - rect.maxY }
    let item = NSPreviewRepresentingActivityItem(item: file as NSURL, title: name, image: NSImage(contentsOf: file), icon: nil)
    let picker = NSSharingServicePicker(items: [item])
    self.picker = picker
    picker.show(relativeTo: rect, of: view, preferredEdge: view.isFlipped ? .maxY : .minY)
  }

  // The temporary folder the engine writes captures to, for the marked-up ones.
  static func temporaryPNG() -> URL {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("Bay Captures", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent(UUID().uuidString).appendingPathExtension("png")
  }
}

// Mark Up: the capture, fitted to the view, with pen, highlighter, arrow, box, oval and text marks drawn over it.
// Marks are kept in the image's pixels (from its top-left), so exporting draws them at full size whatever the view's.
final class CaptureCanvasView: ExpoView, NSTextFieldDelegate, NSMenuItemValidation {
  enum Tool: String { case pen, highlighter, arrow, rect, oval, text }

  enum Shape {
    case stroke([CGPoint])
    case arrow(CGPoint, CGPoint)
    case rect(CGPoint, CGPoint)
    case oval(CGPoint, CGPoint)
    case text(CGPoint, String, CGFloat)
  }

  struct Mark {
    var shape: Shape
    var color: NSColor
    var width: CGFloat
    var highlighter = false
  }

  let onMarkupChange = EventDispatcher()
  var tool: Tool = .pen {
    didSet {
      if tool != .text { commitText() }
      window?.invalidateCursorRects(for: self)
    }
  }
  var color: NSColor = .systemRed
  var lineWidth: CGFloat = 4

  private var image: NSImage?
  private var cgImage: CGImage?
  private var pixels = CGSize.zero
  private var path = ""
  private var marks: [Mark] = []
  private var undone: [Mark] = []
  private var current: Mark?
  private var editor: NSTextField?
  private var editorAt = CGPoint.zero
  private var editorFont: CGFloat = 0

  // What draws: React Native's view paints its layer itself (displayLayer:), so draw(_:) never runs on this one.
  private let surface = MarkupSurface()

  override var isFlipped: Bool { true }
  override var acceptsFirstResponder: Bool { true }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    surface.owner = self
    surface.frame = bounds
    surface.autoresizingMask = [.width, .height]
    addSubview(surface)
  }

  func load(_ path: String) {
    guard path != self.path else { return }
    self.path = path
    guard let data = FileManager.default.contents(atPath: path), let rep = NSBitmapImageRep(data: data) else { return }
    let image = NSImage(size: NSSize(width: rep.pixelsWide, height: rep.pixelsHigh))
    image.addRepresentation(rep)
    self.image = image
    cgImage = rep.cgImage
    pixels = CGSize(width: rep.pixelsWide, height: rep.pixelsHigh)
    marks = []
    undone = []
    changed()
  }

  // MARK: Geometry

  // Where the image is drawn: fitted and centred, never past the size it was on the page.
  private var imageRect: CGRect {
    guard pixels.width > 0, pixels.height > 0, bounds.width > 0, bounds.height > 0 else { return .zero }
    let scale = min(bounds.width / pixels.width, bounds.height / pixels.height, 1 / (window?.backingScaleFactor ?? 2))
    let size = CGSize(width: pixels.width * scale, height: pixels.height * scale)
    return CGRect(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2, width: size.width, height: size.height)
  }

  // Image pixels per view point.
  private var pixelsPerPoint: CGFloat {
    let rect = imageRect
    return rect.width > 0 ? pixels.width / rect.width : 1
  }

  private func toImage(_ p: CGPoint) -> CGPoint {
    let rect = imageRect
    let k = pixelsPerPoint
    return CGPoint(x: min(max((p.x - rect.minX) * k, 0), pixels.width), y: min(max((p.y - rect.minY) * k, 0), pixels.height))
  }

  private func toView(_ p: CGPoint) -> CGPoint {
    let rect = imageRect
    let k = pixelsPerPoint
    return CGPoint(x: rect.minX + p.x / k, y: rect.minY + p.y / k)
  }

  override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    surface.frame = bounds
    surface.needsDisplay = true
    commitText()
    window?.invalidateCursorRects(for: self)
  }

  override func resetCursorRects() {
    addCursorRect(imageRect, cursor: tool == .text ? .iBeam : .crosshair)
  }

  // MARK: Drawing

  fileprivate func drawContents() {
    guard let image, let context = NSGraphicsContext.current?.cgContext else { return }
    let rect = imageRect
    image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
    context.saveGState()
    context.clip(to: rect)
    context.translateBy(x: rect.minX, y: rect.minY)
    context.scaleBy(x: 1 / pixelsPerPoint, y: 1 / pixelsPerPoint)
    for mark in marks { draw(mark, in: context) }
    if let current { draw(current, in: context) }
    context.restoreGState()
  }

  private func draw(_ mark: Mark, in context: CGContext) {
    context.saveGState()
    defer { context.restoreGState() }
    let color = mark.highlighter ? mark.color.withAlphaComponent(0.38) : mark.color
    context.setStrokeColor(color.cgColor)
    context.setFillColor(color.cgColor)
    context.setLineWidth(mark.width)
    context.setLineCap(mark.highlighter ? .square : .round)
    context.setLineJoin(.round)
    if mark.highlighter { context.setBlendMode(.multiply) }
    switch mark.shape {
    case .stroke(let points):
      guard let first = points.first else { return }
      if points.count == 1 {
        context.fillEllipse(in: CGRect(x: first.x - mark.width / 2, y: first.y - mark.width / 2, width: mark.width, height: mark.width))
        return
      }
      // Smoothed through the midpoints, as a pen's line looks.
      context.move(to: first)
      for i in 1..<points.count {
        let mid = CGPoint(x: (points[i - 1].x + points[i].x) / 2, y: (points[i - 1].y + points[i].y) / 2)
        context.addQuadCurve(to: mid, control: points[i - 1])
      }
      context.addLine(to: points[points.count - 1])
      context.strokePath()
    case .arrow(let from, let to):
      let angle = atan2(to.y - from.y, to.x - from.x)
      let head = max(mark.width * 3.6, 14 * pixelsPerPoint)
      let spread = CGFloat.pi / 7
      let base = CGPoint(x: to.x - cos(angle) * head * 0.8, y: to.y - sin(angle) * head * 0.8)
      context.move(to: from)
      context.addLine(to: base)
      context.strokePath()
      context.move(to: to)
      context.addLine(to: CGPoint(x: to.x - cos(angle - spread) * head, y: to.y - sin(angle - spread) * head))
      context.addLine(to: CGPoint(x: to.x - cos(angle + spread) * head, y: to.y - sin(angle + spread) * head))
      context.closePath()
      context.fillPath()
    case .rect(let a, let b):
      let r = CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
      context.addPath(CGPath(roundedRect: r, cornerWidth: min(mark.width, r.width / 2), cornerHeight: min(mark.width, r.height / 2), transform: nil))
      context.strokePath()
    case .oval(let a, let b):
      context.strokeEllipse(in: CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y)))
    case .text(let origin, let text, let size):
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
      (text as NSString).draw(at: origin, withAttributes: Self.textAttributes(size: size, color: mark.color))
      NSGraphicsContext.restoreGraphicsState()
    }
  }

  private static func textAttributes(size: CGFloat, color: NSColor) -> [NSAttributedString.Key: Any] {
    let shadow = NSShadow()
    shadow.shadowColor = (color.brightnessComponent(fallback: 0) > 0.6 ? NSColor.black : NSColor.white).withAlphaComponent(0.55)
    shadow.shadowBlurRadius = size / 8
    return [.font: NSFont.systemFont(ofSize: size, weight: .semibold), .foregroundColor: color, .shadow: shadow]
  }

  // MARK: Input

  override func mouseDown(with event: NSEvent) {
    window?.makeFirstResponder(self)
    let p = convert(event.locationInWindow, from: nil)
    guard image != nil, imageRect.contains(p) else { return commitText() }
    if tool == .text { return beginText(at: p) }
    commitText()
    let at = toImage(p)
    let width = (tool == .highlighter ? lineWidth * 4 : lineWidth) * pixelsPerPoint
    let shape: Shape
    switch tool {
    case .pen, .highlighter, .text: shape = .stroke([at])
    case .arrow: shape = .arrow(at, at)
    case .rect: shape = .rect(at, at)
    case .oval: shape = .oval(at, at)
    }
    current = Mark(shape: shape, color: color, width: width, highlighter: tool == .highlighter)
    surface.needsDisplay = true
  }

  override func mouseDragged(with event: NSEvent) {
    guard var mark = current else { return }
    var at = toImage(convert(event.locationInWindow, from: nil))
    switch mark.shape {
    case .stroke(var points):
      // A highlighter held with ⇧ keeps to its first row, as a marker along a line of text.
      if mark.highlighter, event.modifierFlags.contains(.shift), let first = points.first { at.y = first.y }
      points.append(at)
      mark.shape = .stroke(points)
    case .arrow(let from, _): mark.shape = .arrow(from, at)
    case .rect(let from, _): mark.shape = .rect(from, event.modifierFlags.contains(.shift) ? square(from, at) : at)
    case .oval(let from, _): mark.shape = .oval(from, event.modifierFlags.contains(.shift) ? square(from, at) : at)
    case .text: break
    }
    current = mark
    surface.needsDisplay = true
  }

  override func mouseUp(with event: NSEvent) {
    guard let mark = current else { return }
    current = nil
    // A click with a shape tool draws nothing.
    switch mark.shape {
    case .arrow(let a, let b), .rect(let a, let b), .oval(let a, let b):
      if hypot(a.x - b.x, a.y - b.y) < 3 * pixelsPerPoint {
        surface.needsDisplay = true
        return
      }
    default: break
    }
    add(mark)
  }

  private func square(_ from: CGPoint, _ to: CGPoint) -> CGPoint {
    let side = max(abs(to.x - from.x), abs(to.y - from.y))
    return CGPoint(x: from.x + (to.x >= from.x ? side : -side), y: from.y + (to.y >= from.y ? side : -side))
  }

  private func add(_ mark: Mark) {
    marks.append(mark)
    undone = []
    changed()
  }

  // MARK: Text

  private func beginText(at p: CGPoint) {
    commitText()
    let points: CGFloat = max(14, lineWidth * 4.5)
    let field = NSTextField(string: "")
    field.isBordered = false
    field.drawsBackground = false
    field.focusRingType = .none
    field.font = .systemFont(ofSize: points, weight: .semibold)
    field.textColor = color
    field.placeholderString = "Text"
    field.delegate = self
    field.cell?.wraps = false
    field.cell?.isScrollable = true
    field.frame = CGRect(x: p.x - 2, y: p.y - points * 0.7, width: max(80, imageRect.maxX - p.x), height: points * 1.4)
    addSubview(field)
    editor = field
    editorAt = toImage(CGPoint(x: p.x, y: p.y - points * 0.7))
    editorFont = points * pixelsPerPoint
    window?.makeFirstResponder(field)
  }

  func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
    if selector == #selector(NSResponder.insertNewline(_:)) || selector == #selector(NSResponder.cancelOperation(_:)) {
      commitText()
      window?.makeFirstResponder(self)
      return true
    }
    return false
  }

  func controlTextDidEndEditing(_ obj: Notification) {
    commitText()
  }

  private func commitText() {
    guard let field = editor else { return }
    editor = nil
    let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let color = field.textColor ?? self.color
    field.delegate = nil
    field.removeFromSuperview()
    if !text.isEmpty { add(Mark(shape: .text(editorAt, text, editorFont), color: color, width: 0)) }
  }

  // MARK: Edits

  @objc func undo(_ sender: Any?) {
    commitText()
    guard let last = marks.popLast() else { return }
    undone.append(last)
    changed()
  }

  @objc func redo(_ sender: Any?) {
    guard let next = undone.popLast() else { return }
    marks.append(next)
    changed()
  }

  func clear() {
    commitText()
    guard !marks.isEmpty else { return }
    undone = marks.reversed()
    marks = []
    changed()
  }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    if item.action == #selector(undo(_:)) { return !marks.isEmpty }
    if item.action == #selector(redo(_:)) { return !undone.isEmpty }
    return true
  }

  private func changed() {
    surface.needsDisplay = true
    onMarkupChange(["canUndo": !marks.isEmpty, "canRedo": !undone.isEmpty, "marks": marks.count])
  }

  // The image with its marks at full size, as a new PNG in the capture's colour space (Chrome's are the display's):
  // its path and size in pixels.
  func export() -> [String: Any]? {
    commitText()
    guard let source = cgImage, pixels.width > 0 else { return nil }
    let size = (width: Int(pixels.width), height: Int(pixels.height))
    let info = CGImageAlphaInfo.premultipliedLast.rawValue
    guard
      let cg = CGContext(
        data: nil, width: size.width, height: size.height, bitsPerComponent: 8, bytesPerRow: 0,
        space: source.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: info)
        ?? CGContext(
          data: nil, width: size.width, height: size.height, bitsPerComponent: 8, bytesPerRow: 0,
          space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: info)
    else { return nil }
    cg.draw(source, in: CGRect(origin: .zero, size: pixels))
    // Marks are kept from the top-left.
    cg.translateBy(x: 0, y: pixels.height)
    cg.scaleBy(x: 1, y: -1)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
    for mark in marks { draw(mark, in: cg) }
    NSGraphicsContext.restoreGraphicsState()
    let file = CaptureFiles.temporaryPNG()
    guard let out = cg.makeImage(),
          let destination = CGImageDestinationCreateWithURL(file as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(destination, out, nil)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return ["path": file.path, "width": size.width, "height": size.height]
  }
}

// The canvas's drawing, under its text field; clicks go through to the canvas.
private final class MarkupSurface: NSView {
  weak var owner: CaptureCanvasView?
  override var isFlipped: Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func draw(_ dirtyRect: NSRect) { owner?.drawContents() }
}

private extension NSColor {
  func brightnessComponent(fallback: CGFloat) -> CGFloat {
    usingColorSpace(.deviceRGB)?.brightnessComponent ?? fallback
  }
}
