// Compiled against the production bookmark helper by scripts/test-local-files.py.
func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
  guard condition() else { fatalError(message) }
}

let fm = FileManager.default
let fixture = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let root = fixture.appendingPathComponent("pinned", isDirectory: true)
let pdf = root.appendingPathComponent("example.pdf")
let vault = LocalFileBookmarks.shared

if CommandLine.arguments[1] == "seed" {
  try fm.createDirectory(at: root.appendingPathComponent("nested"), withIntermediateDirectories: true)
  try Data("pdf".utf8).write(to: pdf)
  try Data("image".utf8).write(to: root.appendingPathComponent("image.png"))
  try Data("html".utf8).write(to: root.appendingPathComponent("page.html"))
  try Data("other".utf8).write(to: root.appendingPathComponent("document.docx"))
  let outside = fixture.appendingPathComponent("outside.txt")
  try Data("private".utf8).write(to: outside)
  try fm.createSymbolicLink(at: root.appendingPathComponent("escape.txt"), withDestinationURL: outside)
  try fm.createSymbolicLink(at: root.appendingPathComponent("loop"), withDestinationURL: root)
  expect(vault.inspect(root.path, "")["status"] as? String == "inaccessible", "A synced path must not grant access")
  expect(vault.inspect(fixture.appendingPathComponent("absent").path, "")["status"] as? String == "missing", "Absent synced paths show missing")
  let granted = try vault.grant(root)
  expect(Set(granted.keys) == Set(["path", "name", "kind"]), "Grant metadata must not expose bookmarks")
  expect(vault.inspect(root.path, "example.pdf")["browserReadable"] as? Bool == true, "PDFs open in browser")
  expect(vault.inspect(root.path, "image.png")["browserReadable"] as? Bool == true, "Images open in browser")
  expect(vault.inspect(root.path, "page.html")["browserReadable"] as? Bool == true, "HTML opens in browser")
  expect(vault.inspect(root.path, "document.docx")["browserReadable"] as? Bool == false, "Other types use an app")
  let dragItem = NSDraggingItem(pasteboardWriter: pdf as NSURL)
  expect(dragItem.item is NSURL, "Native drag carries an NSURL, not a display string")
  let pasteboard = NSPasteboard.withUniqueName()
  expect(pasteboard.writeObjects([pdf as NSURL]), "Write native file URL to pasteboard")
  expect(pasteboard.types?.contains(.fileURL) == true, "Pasteboard advertises public.file-url for upload destinations")
  let readBack = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]
  expect(readBack?.first?.path == pdf.path, "Native file URL round-trips through the pasteboard")
  pasteboard.releaseGlobally()
  expect(vault.authorizedURL(root.path, "../outside.txt") == nil, "Reject traversal")
  expect(vault.authorizedURL(root.path, outside.path) == nil, "Reject absolute descendant paths")
  expect(vault.authorizedURL(root.path, "escape.txt") == nil, "Reject symlink escapes")
  let listing = vault.list(root.path, "")
  let entries = listing["entries"] as! [[String: Any]]
  expect(entries.first?["name"] as? String == "nested", "Folders sort first")
  expect(!entries.contains { $0["name"] as? String == "escape.txt" }, "Listing must not expose external symlinks")
  expect(!entries.contains { $0["name"] as? String == "loop" }, "Directory symlinks must not create tree cycles")
  expect(entries.contains { $0["relativePath"] as? String == "example.pdf" }, "Listing returns root-relative paths")
  let alias = fixture.appendingPathComponent("synced-root").path
  _ = try vault.grant(root, alias: alias)
  expect(vault.inspect(alias, "example.pdf")["status"] as? String == "available", "Reconnect retains original synced path alias")
  let movable = fixture.appendingPathComponent("movable", isDirectory: true)
  let moved = fixture.appendingPathComponent("moved", isDirectory: true)
  try fm.createDirectory(at: movable, withIntermediateDirectories: true)
  _ = try vault.grant(movable)
  expect(vault.inspect(movable.path, "")["status"] as? String == "available", "Resolve root before moving")
  try fm.moveItem(at: movable, to: moved)
  expect(vault.inspect(movable.path, "")["path"] as? String == moved.path, "A cached bookmark follows a moved root")
  let accessFile = try ShellModule.documentURL("local-file-access.plist")
  let mode = try fm.attributesOfItem(atPath: accessFile.path)[.posixPermissions] as! NSNumber
  expect(mode.intValue == 0o600, "Bookmark file is readable by this user only")
  let nativeFile = fixture.appendingPathComponent("Finder Drop.pdf")
  try Data("native drop".utf8).write(to: nativeFile)
  expect(vault.inspect(nativeFile.path, "")["status"] as? String == "inaccessible", "A native drop fixture starts without a grant")
  let destination = LocalFilesArea(frame: NSRect(x: 0, y: 0, width: 200, height: 40))
  expect(!destination.registeredDraggedTypes.contains(.fileURL), "Rows do not intercept their parent drop destination")
  destination.dropEnabled = true
  expect(destination.registeredDraggedTypes.contains(.fileURL), "A Finder drop zone registers native file URLs")
  let incoming = [NSDraggingItem(pasteboardWriter: nativeFile as NSURL)]
  let nativeBoard = LocalFileNativeDrag.pasteboard(incoming)!
  let nativeInfo = LocalFileTestDraggingInfo(window: nil, board: nativeBoard, point: .zero, source: nil, items: incoming)
  expect(destination.draggingEntered(nativeInfo) == .copy, "Production native destination accepts file URLs")
  expect(destination.prepareForDragOperation(nativeInfo), "Production native destination prepares a Finder drop")
  expect(destination.performDragOperation(nativeInfo), "Production native destination performs a Finder drop")
  let dropped = destination.onFilesDropped.events.last?["files"] as? [[String: Any]]
  expect(dropped?.first?["path"] as? String == nativeFile.path, "Production handler publishes native descriptor to JS")
  expect(vault.inspect(nativeFile.path, "")["status"] as? String == "available", "Production native handler persists the grant before emitting")
  expect(LocalFileNativeDrag.item(nativeFile.path, "")?.item is NSURL, "Production source helper prepares a real NSURL drag item")
  expect(LocalFileNativeDrag.item(nativeFile.path, "../outside.txt") == nil, "Production source helper rejects traversal")
  expect(destination.accessibilityPerformPress(), "Production native row supports accessibility press")
  expect(destination.onActivate.events.count == 1, "Accessibility press invokes the row's native event")
  destination.dropEnabled = false
  expect(!destination.registeredDraggedTypes.contains(.fileURL), "Disabled destinations unregister native drops")
  expect(!destination.performDragOperation(nativeInfo), "Disabled production destination rejects a Finder drop")
  nativeBoard.releaseGlobally()
  if ProcessInfo.processInfo.environment["BAY_BACKGROUND"] != "1" {
    expect(LocalFileAcceptance.drop("not-a-window", [nativeFile.path])["error"] as? String == "test instances only", "Native grant injection is disabled outside hidden acceptance instances")
    var uploadDenied = false
    LocalFileAcceptance.upload("not-a-window", nativeFile.path, "", .zero) { result in
      uploadDenied = result["error"] as? String == "test instances only"
    }
    expect(uploadDenied, "Native upload injection is disabled outside hidden acceptance instances")
  }
  print("PASS production native destination, source payload, registration and accessibility checks")
  print("PASS native grant, classification, tree, traversal, symlink and reconnect checks")
} else {
  expect(vault.inspect(root.path, "example.pdf")["status"] as? String == "available", "Bookmarks survive a fresh process")
  let alias = fixture.appendingPathComponent("synced-root").path
  expect(vault.inspect(alias, "example.pdf")["status"] as? String == "available", "Reconnect aliases survive a fresh process")
  let movable = fixture.appendingPathComponent("movable").path
  expect(vault.inspect(movable, "")["path"] as? String == fixture.appendingPathComponent("moved").path, "Moved bookmark refresh survives a fresh process")
  try fm.removeItem(at: pdf)
  expect(vault.inspect(root.path, "example.pdf")["status"] as? String == "missing", "Deleted files become missing")
  print("PASS native relaunch and missing-file checks")
}
