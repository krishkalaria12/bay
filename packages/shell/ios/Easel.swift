import AppKit
import ExpoModulesCore
import ImageIO
import UniformTypeIdentifiers

// Separate modules keep Capture and Easel compatible with the legacy React Native bridge.
public class EaselModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BayEasel")

    AsyncFunction("retainLibraryImage") { (path: String) -> [String: Any]? in
      EaselFiles.retain(path)
    }.runOnQueue(.main)
    AsyncFunction("removeLibraryImage") { (path: String) -> Bool in EaselFiles.remove(path) }
    AsyncFunction("libraryImageExists") { (path: String) -> Bool in
      EaselFiles.localURL(path).map { FileManager.default.fileExists(atPath: $0.path) } ?? false
    }
    AsyncFunction("exportEaselHTML") { (document: String) -> String? in
      EaselFiles.exportHTML(document)
    }.runOnQueue(.main)

    View(EaselCanvasView.self) {
      Events("onEaselChange", "onEaselOpenLink")
      Prop("document") { (view: EaselCanvasView, value: String) in view.load(value) }
      Prop("tool") { (view: EaselCanvasView, value: String) in view.setTool(value) }
      Prop("color") { (view: EaselCanvasView, value: String) in view.ink = value }
      Prop("lineWidth") { (view: EaselCanvasView, value: Double) in view.strokeWidth = value.isFinite ? min(1000, max(0.5, value)) : 2 }
      Prop("dark") { (view: EaselCanvasView, value: Bool) in view.dark = value }
      AsyncFunction("undo") { (view: EaselCanvasView) in view.undo(nil) }.runOnQueue(.main)
      AsyncFunction("redo") { (view: EaselCanvasView) in view.redo(nil) }.runOnQueue(.main)
      AsyncFunction("selectAll") { (view: EaselCanvasView) in view.selectAll(nil) }.runOnQueue(.main)
      AsyncFunction("deleteSelection") { (view: EaselCanvasView) in view.deleteSelection() }.runOnQueue(.main)
      AsyncFunction("duplicateSelection") { (view: EaselCanvasView) in view.duplicateSelection() }.runOnQueue(.main)
      AsyncFunction("bringToFront") { (view: EaselCanvasView) in view.reorder(front: true) }.runOnQueue(.main)
      AsyncFunction("sendToBack") { (view: EaselCanvasView) in view.reorder(front: false) }.runOnQueue(.main)
      AsyncFunction("zoomIn") { (view: EaselCanvasView) in view.zoom(by: 1.2) }.runOnQueue(.main)
      AsyncFunction("zoomOut") { (view: EaselCanvasView) in view.zoom(by: 1 / 1.2) }.runOnQueue(.main)
      AsyncFunction("fit") { (view: EaselCanvasView) in view.fit() }.runOnQueue(.main)
      AsyncFunction("export") { (view: EaselCanvasView) -> [String: Any]? in view.export() }.runOnQueue(.main)
      AsyncFunction("addText") { (view: EaselCanvasView, text: String) in view.addText(text) }.runOnQueue(.main)
      AsyncFunction("addLink") { (view: EaselCanvasView, url: String, title: String) in view.addLink(url, title: title) }.runOnQueue(.main)
      AsyncFunction("addImages") { (view: EaselCanvasView, paths: [String]) in view.addImages(paths) }.runOnQueue(.main)
      AsyncFunction("focus") { (view: EaselCanvasView) in _ = view.window?.makeFirstResponder(view) }.runOnQueue(.main)
    }
  }
}

// Easel keeps dictionaries rather than a fixed Codable schema so future item/source fields survive edits.
enum EaselFiles {
  static func localURL(_ path: String) -> URL? {
    if path.hasPrefix("/") { return URL(fileURLWithPath: path) }
    guard let url = URL(string: path), url.isFileURL else { return nil }
    return url
  }

  static func mediaDirectory() throws -> URL {
    let dir = try ShellModule.documentURL("Library Media")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.resolvingSymlinksInPath().standardizedFileURL
  }

  static func retain(_ path: String) -> [String: Any]? {
    guard let url = localURL(path), let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    let width = (props?[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue ?? 1
    let height = (props?[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue ?? 1
    let scale = min(1, 16384 / max(width, height), sqrt(32_000_000 / max(1, width * height)))
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: max(1, Int(max(width, height) * scale)),
      kCGImageSourceShouldCacheImmediately: true,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
    return retain(image)
  }

  static func retain(_ image: CGImage) -> [String: Any]? {
    guard let dir = try? mediaDirectory() else { return nil }
    let url = dir.appendingPathComponent(UUID().uuidString).appendingPathExtension("png")
    guard writePNG(image, to: url) else { return nil }
    return ["path": url.path, "width": image.width, "height": image.height]
  }

  static func writePNG(_ image: CGImage, to url: URL) -> Bool {
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { return false }
    CGImageDestinationAddImage(destination, image, nil)
    if CGImageDestinationFinalize(destination) { return true }
    try? FileManager.default.removeItem(at: url)
    return false
  }

  static func remove(_ path: String) -> Bool {
    guard let dir = try? mediaDirectory(), let local = localURL(path) else { return false }
    let url = local.resolvingSymlinksInPath().standardizedFileURL
    // Do not permit deleting the directory, unrelated files, or a symlink's external target.
    guard url.deletingLastPathComponent() == dir, url.pathExtension.lowercased() == "png" else { return false }
    do { try FileManager.default.removeItem(at: url); return true } catch { return false }
  }

  static func parse(_ string: String) -> [String: Any]? {
    guard let data = string.data(using: .utf8), let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          doc["id"] is String, doc["items"] is [[String: Any]] else { return nil }
    return doc
  }

  static func json(_ value: Any) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8) else { return "{}" }
    return text
  }

  static func safeURL(_ text: String) -> URL? {
    guard let url = URL(string: text), let scheme = url.scheme?.lowercased(),
          ["https", "http"].contains(scheme) else { return nil }
    if url.host?.isEmpty != false { return nil }
    return url
  }

  static func escaped(_ text: String) -> String {
    text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
      .replacingOccurrences(of: "'", with: "&#39;")
  }

  static func exportHTML(_ string: String) -> String? {
    guard let doc = parse(string), let items = doc["items"] as? [[String: Any]],
          let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first else { return nil }
    var cache: [String: NSImage] = [:]
    EaselDrawing.cacheImages(items, into: &cache)
    let title = doc["title"] as? String ?? "Easel"
    var picture = "<p>Empty canvas</p>"
    if !items.isEmpty {
      guard let image = EaselDrawing.render(doc, cache: cache),
            let rep = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { return nil }
      picture = "<img alt=\"\(escaped(title))\" width=\"\(image.width)\" height=\"\(image.height)\" src=\"data:image/png;base64,\(rep.base64EncodedString())\">"
    }
    var links: [String] = []
    for item in items {
      let source = item["source"] as? [String: Any]
      guard let value = (source?["url"] as? String) ?? (item["url"] as? String), let url = safeURL(value) else { continue }
      let label = (source?["title"] as? String) ?? (item["text"] as? String) ?? value
      links.append("<li><a href=\"\(escaped(url.absoluteString))\" rel=\"noreferrer noopener\">\(escaped(label))</a></li>")
    }
    let html = """
    <!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>\(escaped(title))</title><style>body{margin:32px;font:16px system-ui,sans-serif;color:#202124;background:#fafafa}h1{font-size:24px}img{max-width:100%;height:auto;border:1px solid #ddd}a{color:#165dce}li{margin:8px 0}</style>
    <h1>\(escaped(title))</h1>\(picture)\(links.isEmpty ? "" : "<h2>Sources</h2><ul>" + links.joined() + "</ul>")</html>
    """
    let file = CaptureFiles.unique(in: downloads, name: title.isEmpty ? "Easel" : String(title.prefix(120)), ext: "html")
    do { try html.write(to: file, atomically: true, encoding: .utf8); return file.path } catch { return nil }
  }
}

private enum EaselDrawing {
  static func number(_ item: [String: Any], _ key: String, _ fallback: CGFloat = 0) -> CGFloat {
    guard let value = item[key] as? NSNumber, value.doubleValue.isFinite else { return fallback }
    return min(10_000_000, max(-10_000_000, CGFloat(value.doubleValue)))
  }

  static func rect(_ item: [String: Any]) -> CGRect {
    CGRect(x: number(item, "x"), y: number(item, "y"), width: max(1, number(item, "width", 1)), height: max(1, number(item, "height", 1)))
  }

  static func points(_ item: [String: Any]) -> [CGPoint] {
    // Read through NSNumber, as number() does: a stroke being drawn holds CGFloats, a saved one Doubles, and a
    // [[Double]] cast fails on the first (the draft then fell back to a corner-to-corner line).
    (item["points"] as? [[Any]] ?? []).compactMap { pair in
      guard pair.count >= 2, let x = (pair[0] as? NSNumber)?.doubleValue, let y = (pair[1] as? NSNumber)?.doubleValue,
            x.isFinite, y.isFinite else { return nil }
      return CGPoint(x: min(10_000_000, max(-10_000_000, x)), y: min(10_000_000, max(-10_000_000, y)))
    }
  }

  static func contentBounds(_ items: [[String: Any]]) -> CGRect? {
    guard !items.isEmpty else { return nil }
    return items.reduce(CGRect.null) { result, item in
      let width = max(0.5, number(item, "lineWidth", 2))
      let padding = item["kind"] as? String == "arrow" ? max(12, width * 4) : max(2, width * 2)
      return result.union(rect(item).insetBy(dx: -padding, dy: -padding))
    }.integral
  }

  static func cacheImages(_ items: [[String: Any]], into cache: inout [String: NSImage]) {
    let paths = Set(items.compactMap { $0["path"] as? String })
    cache = cache.filter { paths.contains($0.key) }
    for path in paths where cache[path] == nil {
      if let url = EaselFiles.localURL(path), let image = NSImage(contentsOf: url) {
        // Decode once during load/import, never from mouse-driven drawing.
        var bounds = CGRect(origin: .zero, size: image.size)
        if let cg = image.cgImage(forProposedRect: &bounds, context: nil, hints: nil) {
          cache[path] = NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
        }
      }
    }
  }

  static func draw(_ item: [String: Any], cache: [String: NSImage], context cg: CGContext) {
    let r = rect(item)
    let color = NSColor(hex: item["color"] as? String ?? "#222222") ?? .labelColor
    let width = max(0.5, number(item, "lineWidth", 2))
    cg.saveGState()
    defer { cg.restoreGState() }
    cg.setStrokeColor(color.cgColor)
    cg.setFillColor(color.cgColor)
    cg.setLineWidth(width)
    cg.setLineCap(.round)
    cg.setLineJoin(.round)
    switch item["kind"] as? String {
    case "image":
      if let path = item["path"] as? String, let image = cache[path] {
        image.draw(in: r, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
      } else {
        cg.setFillColor(NSColor.controlBackgroundColor.cgColor)
        cg.fill(r)
        (item["live"] as? Bool == true ? "Live clip" : "Image unavailable" as NSString).draw(in: r.insetBy(dx: 12, dy: 12), withAttributes: [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.secondaryLabelColor])
      }
    case "text", "link":
      let link = item["kind"] as? String == "link"
      if link {
        cg.setFillColor(color.withAlphaComponent(0.08).cgColor)
        cg.fill(r)
        cg.stroke(r)
      }
      cg.clip(to: r)
      let text = (item["text"] as? String) ?? (item["url"] as? String) ?? ""
      let font = NSFont.systemFont(ofSize: max(1, number(item, "fontSize", link ? 16 : 24)))
      (text as NSString).draw(with: link ? r.insetBy(dx: 12, dy: 12) : r, options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: font, .foregroundColor: color])
    case "rect": cg.stroke(r)
    case "ellipse": cg.strokeEllipse(in: r)
    case "pen", "arrow":
      var pts = points(item)
      if pts.isEmpty { pts = [.zero, CGPoint(x: r.width, y: r.height)] }
      pts = pts.map { CGPoint(x: r.minX + $0.x, y: r.minY + $0.y) }
      guard let first = pts.first else { return }
      cg.move(to: first)
      if pts.count == 1 { cg.addLine(to: CGPoint(x: first.x + 0.1, y: first.y)) }
      for point in pts.dropFirst() { cg.addLine(to: point) }
      cg.strokePath()
      if item["kind"] as? String == "arrow", pts.count >= 2, let last = pts.last {
        let before = pts[pts.count - 2]
        let angle = atan2(last.y - before.y, last.x - before.x)
        let length = max(12, width * 4)
        for offset: CGFloat in [-0.5, 0.5] {
          cg.move(to: last)
          cg.addLine(to: CGPoint(x: last.x - cos(angle + offset) * length, y: last.y - sin(angle + offset) * length))
        }
        cg.strokePath()
      }
    default: break
    }
  }

  static func render(_ document: [String: Any], cache: [String: NSImage]) -> CGImage? {
    let items = document["items"] as? [[String: Any]] ?? []
    guard let bounds = contentBounds(items), bounds.width > 0, bounds.height > 0 else { return nil }
    // Bound memory for very large worlds while still exporting every item.
    let scale = min(1, 16384 / max(bounds.width, bounds.height), sqrt(32_000_000 / (bounds.width * bounds.height)))
    let w = max(1, Int(ceil(bounds.width * scale))), h = max(1, Int(ceil(bounds.height * scale)))
    guard let cg = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                             space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    cg.translateBy(x: 0, y: CGFloat(h))
    cg.scaleBy(x: scale, y: -scale)
    cg.translateBy(x: -bounds.minX, y: -bounds.minY)
    cg.setFillColor((NSColor(hex: document["background"] as? String ?? "#ffffff") ?? .white).cgColor)
    cg.fill(bounds)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
    for item in items { draw(item, cache: cache, context: cg) }
    NSGraphicsContext.restoreGraphicsState()
    return cg.makeImage()
  }
}

final class EaselCanvasView: ExpoView, NSTextFieldDelegate, NSMenuItemValidation {
  let onEaselChange = EventDispatcher()
  let onEaselOpenLink = EventDispatcher()
  var ink = "#222222"
  var strokeWidth: CGFloat = 2
  var dark = false { didSet { surface.needsDisplay = true } }
  private var tool = "select"
  private var document: [String: Any] = ["id": "", "items": []]
  private var items: [[String: Any]] {
    get { document["items"] as? [[String: Any]] ?? [] }
    set { document["items"] = newValue }
  }
  private var history: [[String: Any]] = []
  private var future: [[String: Any]] = []
  private var selection = Set<String>()
  private var imageCache: [String: NSImage] = [:]
  // Only this canvas's native edit IDs identify delayed echoes. Equal historical content can be a foreign edit.
  private var emittedEditIDs: [String] = []
  private var viewport = CGPoint.zero
  private var zoomScale: CGFloat = 1
  private let surface = EaselSurface()
  private var editor: NSTextField?
  private var editingID: String?
  private var editingKey = "text"
  private var spaceHeld = false
  private var downScreen = CGPoint.zero
  private var downWorld = CGPoint.zero
  private var downViewport = CGPoint.zero
  private var beforeDrag: [String: Any]?
  private var dragSelection = Set<String>()
  private var mode = ""
  private var resizingCorner = -1
  private var resizeBounds = CGRect.zero
  private var marquee: CGRect?
  private var draft: [String: Any]?
  private var strokePoints: [CGPoint] = []
  private static let clipboardType = NSPasteboard.PasteboardType("com.bay.easel.items")

  override var isFlipped: Bool { true }
  override var acceptsFirstResponder: Bool { true }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    surface.owner = self
    surface.frame = bounds
    surface.autoresizingMask = [.width, .height]
    addSubview(surface)
    registerForDraggedTypes([.fileURL, .png, .tiff, .URL, .string, Self.clipboardType])
  }

  func load(_ string: String) {
    guard let next = EaselFiles.parse(string) else { return }
    guard EaselFiles.json(next) != EaselFiles.json(document) else { return }
    let sameDocument = next["id"] as? String == document["id"] as? String
    if sameDocument {
      let incomingItems = EaselFiles.json(next["items"] as? [[String: Any]] ?? [])
      if incomingItems == EaselFiles.json(items) {
        // Persistence may replace updatedAt or rename the document when echoing a native edit.
        // Those metadata updates must not discard selection, an active gesture, or undo history.
        document = next
        surface.needsDisplay = true
        return
      }
      if let editID = next["nativeEditId"] as? String, emittedEditIDs.contains(editID) { return }
    }
    cancelEditor()
    document = next
    history = []
    future = []
    beforeDrag = nil
    draft = nil
    marquee = nil
    mode = ""
    selection = []
    if !sameDocument { viewport = .zero; zoomScale = 1 }
    EaselDrawing.cacheImages(items, into: &imageCache)
    surface.needsDisplay = true
    DispatchQueue.main.async { [weak self] in self?.emit() }
  }

  func setTool(_ value: String) {
    guard value != tool else { return }
    tool = value
    // Committing a text edit can emit state; report the incoming tool so the toolbar does not revert it.
    commitText()
    window?.invalidateCursorRects(for: self)
  }

  override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    surface.frame = bounds
    if editor != nil { commitText() }
    surface.needsDisplay = true
    // Layout changes also affect overlays even without a document edit.
    emit()
  }

  override func resetCursorRects() {
    addCursorRect(bounds, cursor: tool == "hand" || spaceHeld ? .openHand : tool == "text" ? .iBeam : tool == "select" ? .arrow : .crosshair)
  }

  private func world(_ point: CGPoint) -> CGPoint {
    CGPoint(x: point.x / zoomScale + viewport.x, y: point.y / zoomScale + viewport.y)
  }
  private func screen(_ point: CGPoint) -> CGPoint {
    CGPoint(x: (point.x - viewport.x) * zoomScale, y: (point.y - viewport.y) * zoomScale)
  }
  private func id(_ item: [String: Any]) -> String { item["id"] as? String ?? "" }
  private var center: CGPoint { world(CGPoint(x: bounds.midX, y: bounds.midY)) }
  private var selectedBounds: CGRect? {
    let chosen = items.filter { selection.contains(id($0)) }
    return chosen.isEmpty ? nil : chosen.reduce(CGRect.null) { $0.union(EaselDrawing.rect($1)) }
  }
  private func corners(_ rect: CGRect) -> [CGPoint] {
    [CGPoint(x: rect.minX, y: rect.minY), CGPoint(x: rect.maxX, y: rect.minY), CGPoint(x: rect.maxX, y: rect.maxY), CGPoint(x: rect.minX, y: rect.maxY)]
  }

  fileprivate func drawContents() {
    guard let cg = NSGraphicsContext.current?.cgContext else { return }
    let background = NSColor(hex: document["background"] as? String ?? "") ?? (dark ? NSColor(calibratedWhite: 0.10, alpha: 1) : .white)
    background.setFill()
    bounds.fill()
    cg.saveGState()
    cg.scaleBy(x: zoomScale, y: zoomScale)
    cg.translateBy(x: -viewport.x, y: -viewport.y)
    for item in items { EaselDrawing.draw(item, cache: imageCache, context: cg) }
    if let draft { EaselDrawing.draw(draft, cache: imageCache, context: cg) }
    cg.restoreGState()
    cg.setStrokeColor(NSColor.systemBlue.cgColor)
    cg.setFillColor(NSColor.systemBlue.withAlphaComponent(0.08).cgColor)
    cg.setLineWidth(1)
    if let selected = selectedBounds {
      let box = CGRect(origin: screen(selected.origin), size: CGSize(width: selected.width * zoomScale, height: selected.height * zoomScale))
      cg.stroke(box)
      for corner in corners(box) {
        let handle = CGRect(x: corner.x - 4, y: corner.y - 4, width: 8, height: 8)
        cg.setFillColor(NSColor.white.cgColor)
        cg.fill(handle)
        cg.stroke(handle)
      }
    }
    if let marquee {
      cg.setFillColor(NSColor.systemBlue.withAlphaComponent(0.08).cgColor)
      cg.fill(marquee)
      cg.stroke(marquee)
    }
  }

  private func emit() {
    surface.needsDisplay = true
    guard (document["id"] as? String)?.isEmpty == false else { return }
    let canonical = EaselFiles.json(document)
    onEaselChange(["document": canonical, "canUndo": !history.isEmpty, "canRedo": !future.isEmpty,
                   "selection": selection.sorted(), "zoom": zoomScale, "tool": tool,
                   "viewport": ["x": viewport.x, "y": viewport.y, "zoom": zoomScale]])
  }

  private func markEdit() {
    let editID = UUID().uuidString
    document["nativeEditId"] = editID
    emittedEditIDs.append(editID)
    if emittedEditIDs.count > 128 { emittedEditIDs.removeFirst() }
  }

  private func record(_ previous: [String: Any]) {
    guard EaselFiles.json(previous) != EaselFiles.json(document) else { emit(); return }
    history.append(previous)
    if history.count > 100 { history.removeFirst() }
    future = []
    document["updatedAt"] = Date().timeIntervalSince1970 * 1000
    markEdit()
    emit()
  }

  @objc func undo(_ sender: Any?) {
    commitText()
    guard let previous = history.popLast() else { return }
    future.append(document)
    document = previous
    markEdit()
    selection = []
    EaselDrawing.cacheImages(items, into: &imageCache)
    emit()
  }

  @objc func redo(_ sender: Any?) {
    commitText()
    guard let next = future.popLast() else { return }
    history.append(document)
    document = next
    markEdit()
    selection = []
    EaselDrawing.cacheImages(items, into: &imageCache)
    emit()
  }

  func deleteSelection() {
    commitText()
    guard !selection.isEmpty else { return }
    let previous = document
    items.removeAll { selection.contains(id($0)) }
    selection = []
    record(previous)
  }

  func duplicateSelection() {
    commitText()
    insertCopies(items.filter { selection.contains(id($0)) }, at: nil)
  }

  func reorder(front: Bool) {
    commitText()
    guard !selection.isEmpty else { return }
    let previous = document
    let chosen = items.filter { selection.contains(id($0)) }
    let remaining = items.filter { !selection.contains(id($0)) }
    items = front ? remaining + chosen : chosen + remaining
    record(previous)
  }

  func zoom(by factor: CGFloat, at point: CGPoint? = nil) {
    commitText()
    let anchor = point ?? CGPoint(x: bounds.midX, y: bounds.midY)
    let location = world(anchor)
    zoomScale = min(8, max(0.05, zoomScale * factor))
    viewport = CGPoint(x: location.x - anchor.x / zoomScale, y: location.y - anchor.y / zoomScale)
    emit()
  }

  func fit() {
    commitText()
    guard let box = EaselDrawing.contentBounds(items) else { viewport = .zero; zoomScale = 1; emit(); return }
    zoomScale = min(4, max(0.05, min(max(1, bounds.width - 64) / box.width, max(1, bounds.height - 64) / box.height)))
    viewport = CGPoint(x: box.midX - bounds.width / (2 * zoomScale), y: box.midY - bounds.height / (2 * zoomScale))
    emit()
  }

  override func scrollWheel(with event: NSEvent) {
    commitText()
    if event.modifierFlags.contains(.command) || event.modifierFlags.contains(.option) {
      zoom(by: exp(event.scrollingDeltaY * 0.01), at: convert(event.locationInWindow, from: nil))
    } else {
      let multiplier: CGFloat = event.hasPreciseScrollingDeltas ? 1 : 16
      viewport.x -= event.scrollingDeltaX * multiplier / zoomScale
      viewport.y -= event.scrollingDeltaY * multiplier / zoomScale
      emit()
    }
  }

  override func magnify(with event: NSEvent) {
    zoom(by: max(0.1, 1 + event.magnification), at: convert(event.locationInWindow, from: nil))
  }

  private func makeItem(_ kind: String, at: CGPoint, width: CGFloat, height: CGFloat) -> [String: Any] {
    ["id": UUID().uuidString, "kind": kind, "x": at.x, "y": at.y, "width": width, "height": height, "color": ink, "lineWidth": strokeWidth]
  }

  func addText(_ text: String, at point: CGPoint? = nil) {
    commitText()
    let previous = document
    var item = makeItem("text", at: point ?? center, width: 280, height: max(40, CGFloat(text.components(separatedBy: "\n").count) * 30))
    item["text"] = text
    item["fontSize"] = 24
    items.append(item)
    selection = [id(item)]
    record(previous)
    if text.isEmpty { beginEditing(item) }
  }

  func addLink(_ url: String, title: String, at point: CGPoint? = nil) {
    commitText()
    guard let address = EaselFiles.safeURL(url)?.absoluteString else { return }
    let previous = document
    var item = makeItem("link", at: point ?? center, width: 320, height: 80)
    item["text"] = title.isEmpty ? url : title
    item["url"] = address
    item["fontSize"] = 16
    items.append(item)
    selection = [id(item)]
    record(previous)
  }

  func addImages(_ paths: [String], at point: CGPoint? = nil) {
    commitText()
    let retained = paths.compactMap { EaselFiles.retain($0) }
    insertImages(retained, at: point ?? center)
  }

  private func insertImages(_ retained: [[String: Any]], at point: CGPoint) {
    guard !retained.isEmpty else { return }
    let previous = document
    selection = []
    for (index, media) in retained.enumerated() {
      let w = EaselDrawing.number(media, "width", 1), h = EaselDrawing.number(media, "height", 1)
      let scale = min(1, 640 / max(w, h))
      var item = makeItem("image", at: CGPoint(x: point.x + CGFloat(index) * 24, y: point.y + CGFloat(index) * 24), width: w * scale, height: h * scale)
      item["path"] = media["path"]
      items.append(item)
      selection.insert(id(item))
    }
    EaselDrawing.cacheImages(items, into: &imageCache)
    record(previous)
  }

  func export() -> [String: Any]? {
    commitText()
    guard let image = EaselDrawing.render(document, cache: imageCache) else { return nil }
    let url = CaptureFiles.temporaryPNG()
    guard EaselFiles.writePNG(image, to: url) else { return nil }
    return ["path": url.path, "width": image.width, "height": image.height]
  }

  // MARK: Mouse editing

  override func mouseDown(with event: NSEvent) {
    commitText()
    window?.makeFirstResponder(self)
    downScreen = convert(event.locationInWindow, from: nil)
    downWorld = world(downScreen)
    downViewport = viewport
    beforeDrag = document
    dragSelection = selection
    if tool == "hand" || spaceHeld || event.buttonNumber == 2 { mode = "pan"; return }
    if tool == "text" { addText("", at: downWorld); mode = ""; return }
    if tool != "select" {
      mode = "draw"
      draft = makeItem(tool, at: downWorld, width: 1, height: 1)
      strokePoints = [downWorld]
      return
    }
    if let box = selectedBounds,
       let corner = corners(box).firstIndex(where: { hypot(screen($0).x - downScreen.x, screen($0).y - downScreen.y) < 9 }) {
      resizingCorner = corner
      resizeBounds = box
      mode = "resize"
      return
    }
    if let hit = items.reversed().first(where: { EaselDrawing.rect($0).insetBy(dx: -4 / zoomScale, dy: -4 / zoomScale).contains(downWorld) }) {
      let hitID = id(hit)
      if event.modifierFlags.contains(.command), let url = hit["url"] as? String, EaselFiles.safeURL(url) != nil {
        onEaselOpenLink(["url": url]); mode = ""; return
      }
      if event.clickCount == 2, ["text", "link"].contains(hit["kind"] as? String ?? "") {
        selection = [hitID]
        beginEditing(hit, key: event.modifierFlags.contains(.option) && hit["kind"] as? String == "link" ? "url" : "text")
        mode = ""
        emit()
        return
      }
      if event.modifierFlags.contains(.shift) {
        if selection.contains(hitID) { selection.remove(hitID); mode = ""; emit(); return }
        selection.insert(hitID)
      } else if !selection.contains(hitID) { selection = [hitID] }
      if event.modifierFlags.contains(.option) {
        // Option-drag duplicates in one history entry when released.
        let chosen = items.filter { selection.contains(id($0)) }
        selection = []
        for var item in chosen { item["id"] = UUID().uuidString; items.append(item); selection.insert(id(item)) }
        markEdit()
      }
      // Movement starts from the post-duplicate items, but undo returns to before duplication.
      dragItems = items
      mode = "move"
    } else {
      if !event.modifierFlags.contains(.shift) { selection = [] }
      dragSelection = selection
      mode = "marquee"
    }
    emit()
  }

  private var dragItems: [[String: Any]] = []

  override func otherMouseDown(with event: NSEvent) { mouseDown(with: event) }
  override func otherMouseDragged(with event: NSEvent) { mouseDragged(with: event) }
  override func otherMouseUp(with event: NSEvent) { mouseUp(with: event) }

  override func mouseDragged(with event: NSEvent) {
    let previousItems = items
    let p = convert(event.locationInWindow, from: nil), at = world(p)
    let dx = at.x - downWorld.x, dy = at.y - downWorld.y
    switch mode {
    case "pan":
      viewport = CGPoint(x: downViewport.x - (p.x - downScreen.x) / zoomScale, y: downViewport.y - (p.y - downScreen.y) / zoomScale)
    case "move":
      items = dragItems.map { value in
        guard selection.contains(id(value)) else { return value }
        var item = value
        item["x"] = EaselDrawing.number(value, "x") + dx
        item["y"] = EaselDrawing.number(value, "y") + dy
        return item
      }
    case "resize":
      guard let previous = beforeDrag?["items"] as? [[String: Any]] else { return }
      let opposite = corners(resizeBounds)[(resizingCorner + 2) % 4]
      var target = CGRect(x: min(opposite.x, at.x), y: min(opposite.y, at.y), width: max(4, abs(opposite.x - at.x)), height: max(4, abs(opposite.y - at.y)))
      if event.modifierFlags.contains(.shift) {
        let ratio = resizeBounds.width / max(1, resizeBounds.height)
        target.size.height = target.width / max(0.001, ratio)
        if resizingCorner < 2 { target.origin.y = opposite.y - target.height }
      }
      let sx = target.width / max(1, resizeBounds.width), sy = target.height / max(1, resizeBounds.height)
      items = previous.map { value in
        guard selection.contains(id(value)) else { return value }
        var item = value
        let old = EaselDrawing.rect(value)
        item["x"] = target.minX + (old.minX - resizeBounds.minX) * sx
        item["y"] = target.minY + (old.minY - resizeBounds.minY) * sy
        item["width"] = old.width * sx
        item["height"] = old.height * sy
        if value["points"] != nil { item["points"] = EaselDrawing.points(value).map { [$0.x * sx, $0.y * sy] } }
        if value["fontSize"] != nil { item["fontSize"] = max(1, EaselDrawing.number(value, "fontSize", 24) * min(sx, sy)) }
        return item
      }
    case "marquee":
      marquee = CGRect(x: min(p.x, downScreen.x), y: min(p.y, downScreen.y), width: abs(p.x - downScreen.x), height: abs(p.y - downScreen.y))
      let box = CGRect(x: min(at.x, downWorld.x), y: min(at.y, downWorld.y), width: abs(dx), height: abs(dy))
      selection = dragSelection.union(items.filter { box.intersects(EaselDrawing.rect($0)) }.map { id($0) })
    case "draw":
      guard var item = draft else { return }
      var end = at
      if event.modifierFlags.contains(.shift), tool == "rect" || tool == "ellipse" {
        let size = max(abs(dx), abs(dy))
        end = CGPoint(x: downWorld.x + (dx < 0 ? -size : size), y: downWorld.y + (dy < 0 ? -size : size))
      }
      let points: [CGPoint]
      if tool == "pen" { strokePoints.append(at); points = strokePoints } else { points = [downWorld, end] }
      let minX = points.map(\.x).min() ?? at.x, minY = points.map(\.y).min() ?? at.y
      item["x"] = minX
      item["y"] = minY
      item["width"] = max(1, (points.map(\.x).max() ?? at.x) - minX)
      item["height"] = max(1, (points.map(\.y).max() ?? at.y) - minY)
      if tool == "pen" || tool == "arrow" { item["points"] = points.map { [$0.x - minX, $0.y - minY] } }
      draft = item
    default: return
    }
    if ["move", "resize"].contains(mode), EaselFiles.json(previousItems) != EaselFiles.json(items) { markEdit() }
    emit()
  }

  override func mouseUp(with event: NSEvent) {
    let previous = beforeDrag
    beforeDrag = nil
    if mode == "draw", var item = draft {
      if tool == "pen", item["points"] == nil { item["points"] = [[0, 0]] }
      let r = EaselDrawing.rect(item)
      // Drawn, not selected: the tool stays ready for the next mark (V selects).
      if tool == "pen" || max(r.width, r.height) * zoomScale > 3 { items.append(item); selection = [] }
    }
    draft = nil
    marquee = nil
    let edited = ["draw", "move", "resize"].contains(mode)
    mode = ""
    dragItems = []
    strokePoints = []
    if edited, let previous { record(previous) } else { emit() }
  }

  // MARK: Native text fields

  private func beginEditing(_ item: [String: Any], key: String = "text") {
    commitText()
    let r = EaselDrawing.rect(item), at = screen(r.origin)
    let field = NSTextField(string: item[key] as? String ?? "")
    field.font = .systemFont(ofSize: max(10, EaselDrawing.number(item, "fontSize", 24) * zoomScale))
    field.textColor = NSColor(hex: item["color"] as? String ?? ink) ?? .labelColor
    field.backgroundColor = dark ? .windowBackgroundColor : .white
    field.isBordered = true
    field.focusRingType = .none
    field.cell?.wraps = true
    field.cell?.isScrollable = false
    field.frame = CGRect(x: at.x, y: at.y, width: max(100, r.width * zoomScale), height: max(32, r.height * zoomScale))
    field.delegate = self
    editingID = id(item)
    editingKey = key
    editor = field
    addSubview(field)
    window?.makeFirstResponder(field)
    if let textView = field.currentEditor() { textView.selectAll(nil) }
    else { field.selectText(nil) }
  }

  private func cancelEditor() {
    let field = editor
    editor = nil
    editingID = nil
    field?.delegate = nil
    field?.removeFromSuperview()
  }

  private func commitText() {
    guard let field = editor, let editingID else { return }
    let text = field.stringValue
    let key = editingKey
    cancelEditor()
    guard let index = items.firstIndex(where: { id($0) == editingID }), items[index][key] as? String != text else { return }
    let value: String
    if key == "url" {
      guard let address = EaselFiles.safeURL(text)?.absoluteString else { return }
      value = address
    } else { value = text }
    let previous = document
    items[index][key] = value
    record(previous)
  }

  func controlTextDidEndEditing(_ notification: Notification) { commitText() }
  func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
    if selector == #selector(NSResponder.cancelOperation(_:)) {
      cancelEditor(); window?.makeFirstResponder(self); return true
    }
    if selector == #selector(NSResponder.insertNewline(_:)) {
      if NSEvent.modifierFlags.contains(.shift) { textView.insertText("\n", replacementRange: textView.selectedRange()) }
      else { commitText(); window?.makeFirstResponder(self) }
      return true
    }
    return false
  }

  // MARK: Clipboard, keyboard and drops

  @objc func copy(_ sender: Any?) {
    commitText()
    let chosen = items.filter { selection.contains(id($0)) }
    guard !chosen.isEmpty else { return }
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(EaselFiles.json(chosen), forType: Self.clipboardType)
    let plain = chosen.compactMap { ($0["url"] as? String) ?? ($0["text"] as? String) }.joined(separator: "\n")
    if !plain.isEmpty { pasteboard.setString(plain, forType: .string) }
  }
  @objc func cut(_ sender: Any?) { copy(sender); deleteSelection() }
  @objc func paste(_ sender: Any?) { _ = paste(NSPasteboard.general, at: center) }
  override func selectAll(_ sender: Any?) { selection = Set(items.map { id($0) }); emit() }
  @objc private func duplicate(_ sender: Any?) { duplicateSelection() }
  @objc private func deleteItems(_ sender: Any?) { deleteSelection() }
  @objc private func editLink(_ sender: Any?) {
    guard let item = items.first(where: { selection.contains(id($0)) && $0["kind"] as? String == "link" }) else { return }
    beginEditing(item, key: "url")
  }
  @objc private func openLink(_ sender: Any?) {
    guard let item = items.first(where: { selection.contains(id($0)) }),
          let url = (item["url"] as? String) ?? ((item["source"] as? [String: Any])?["url"] as? String), EaselFiles.safeURL(url) != nil else { return }
    onEaselOpenLink(["url": url])
  }

  private func insertCopies(_ copies: [[String: Any]], at point: CGPoint?) {
    guard !copies.isEmpty else { return }
    let previous = document
    let box = EaselDrawing.contentBounds(copies) ?? .zero
    let dx = point.map { $0.x - box.minX } ?? 24, dy = point.map { $0.y - box.minY } ?? 24
    selection = []
    for var item in copies {
      item["id"] = UUID().uuidString
      item["x"] = EaselDrawing.number(item, "x") + dx
      item["y"] = EaselDrawing.number(item, "y") + dy
      items.append(item)
      selection.insert(id(item))
    }
    EaselDrawing.cacheImages(items, into: &imageCache)
    record(previous)
  }

  @discardableResult private func paste(_ pasteboard: NSPasteboard, at point: CGPoint) -> Bool {
    commitText()
    if let string = pasteboard.string(forType: Self.clipboardType), let data = string.data(using: .utf8),
       let copied = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]], !copied.isEmpty {
      insertCopies(copied, at: point)
      return true
    }
    if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
      let retained = urls.compactMap { EaselFiles.retain($0.path) }
      if !retained.isEmpty { insertImages(retained, at: point); return true }
    }
    if let image = NSImage(pasteboard: pasteboard) {
      var rect = CGRect(origin: .zero, size: image.size)
      if let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil), let retained = EaselFiles.retain(cg) {
        insertImages([retained], at: point); return true
      }
    }
    if let text = pasteboard.string(forType: .URL) ?? pasteboard.string(forType: .string), !text.isEmpty {
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      if let url = EaselFiles.localURL(trimmed), let retained = EaselFiles.retain(url.path) {
        insertImages([retained], at: point)
      } else if EaselFiles.safeURL(trimmed) != nil { addLink(trimmed, title: trimmed, at: point) }
      else { addText(text, at: point) }
      return true
    }
    return false
  }

  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { .copy }
  override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool { true }
  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
    paste(sender.draggingPasteboard, at: world(convert(sender.draggingLocation, from: nil)))
  }

  override func keyDown(with event: NSEvent) {
    guard editor == nil else { super.keyDown(with: event); return }
    let command = event.modifierFlags.contains(.command), shift = event.modifierFlags.contains(.shift)
    let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
    if event.modifierFlags.intersection([.command, .control, .option]).isEmpty,
       let nextTool = ["v": "select", "h": "hand", "p": "pen", "t": "text", "r": "rect", "o": "ellipse", "a": "arrow"][key] {
      if nextTool != tool { setTool(nextTool); emit() }
      return
    }
    if command {
      switch key {
      case "z": if shift { redo(nil) } else { undo(nil) }; return
      case "a": selectAll(nil); return
      case "c": copy(nil); return
      case "x": cut(nil); return
      case "v": paste(nil); return
      case "d": duplicateSelection(); return
      case "+", "=": zoom(by: 1.2); return
      case "-": zoom(by: 1 / 1.2); return
      case "0": fit(); return
      case "]": reorder(front: true); return
      case "[": reorder(front: false); return
      default: break
      }
    }
    if event.keyCode == 49 { spaceHeld = true; window?.invalidateCursorRects(for: self); return }
    if event.keyCode == 51 || event.keyCode == 117 { deleteSelection(); return }
    if event.keyCode == 53 {
      if let previous = beforeDrag {
        let previousItems = previous["items"] as? [[String: Any]] ?? []
        let changed = EaselFiles.json(items) != EaselFiles.json(previousItems)
        document = previous
        if changed { markEdit() }
      }
      beforeDrag = nil; mode = ""; draft = nil; marquee = nil; selection = []; emit(); return
    }
    if event.keyCode == 36, let item = items.first(where: { selection.contains(id($0)) && ["text", "link"].contains($0["kind"] as? String ?? "") }) {
      beginEditing(item); return
    }
    if [123, 124, 125, 126].contains(event.keyCode), !selection.isEmpty {
      let previous = document, step: CGFloat = shift ? 10 : 1
      items = items.map { value in
        guard selection.contains(id(value)) else { return value }
        var item = value
        item["x"] = EaselDrawing.number(value, "x") + (event.keyCode == 123 ? -step : event.keyCode == 124 ? step : 0)
        item["y"] = EaselDrawing.number(value, "y") + (event.keyCode == 126 ? -step : event.keyCode == 125 ? step : 0)
        return item
      }
      record(previous); return
    }
    super.keyDown(with: event)
  }

  override func keyUp(with event: NSEvent) {
    if event.keyCode == 49 { spaceHeld = false; window?.invalidateCursorRects(for: self) } else { super.keyUp(with: event) }
  }

  override func resignFirstResponder() -> Bool {
    spaceHeld = false
    return super.resignFirstResponder()
  }

  override func menu(for event: NSEvent) -> NSMenu? {
    commitText()
    window?.makeFirstResponder(self)
    let point = world(convert(event.locationInWindow, from: nil))
    if let item = items.reversed().first(where: { EaselDrawing.rect($0).contains(point) }), !selection.contains(id(item)) { selection = [id(item)]; emit() }
    let menu = NSMenu()
    for (title, action) in [("Undo", #selector(undo(_:))), ("Redo", #selector(redo(_:))), ("Cut", #selector(cut(_:))), ("Copy", #selector(copy(_:))), ("Paste", #selector(paste(_:))), ("Duplicate", #selector(duplicate(_:))), ("Select All", #selector(selectAll(_:))), ("Delete", #selector(deleteItems(_:))), ("Edit Link URL", #selector(editLink(_:))), ("Open Link", #selector(openLink(_:)))] {
      let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
      item.target = self
      menu.addItem(item)
    }
    return menu
  }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    if item.action == #selector(undo(_:)) { return !history.isEmpty }
    if item.action == #selector(redo(_:)) { return !future.isEmpty }
    if item.action == #selector(paste(_:)) { return true }
    if item.action == #selector(editLink(_:)) { return items.contains { selection.contains(id($0)) && $0["kind"] as? String == "link" } }
    if item.action == #selector(openLink(_:)) {
      return items.contains { selection.contains(id($0)) && EaselFiles.safeURL(($0["url"] as? String) ?? (($0["source"] as? [String: Any])?["url"] as? String) ?? "") != nil }
    }
    return !selection.isEmpty
  }
}

private final class EaselSurface: NSView {
  weak var owner: EaselCanvasView?
  override var isFlipped: Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func draw(_ dirtyRect: NSRect) { owner?.drawContents() }
}
