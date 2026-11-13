func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
  guard condition() else { fatalError(message) }
}

func makeWindow() -> NSWindow {
  let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: 1360, height: 860),
    styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false
  )
  window.isReleasedWhenClosed = false
  return window
}

_ = NSApplication.shared
let visible = NSScreen.main!.visibleFrame
let preferred = NSRect(x: visible.minX + 30, y: visible.minY + 30,
                       width: min(1000, visible.width - 60), height: min(700, visible.height - 60))
let defaults = UserDefaults.standard
let frameKey = "NSWindow Frame BrowserWindow"
let manager = WindowManager()

if CommandLine.arguments.contains("--restore") {
  defer {
    NSWindow.removeFrame(usingName: "BrowserWindow")
    defaults.removePersistentDomain(forName: ProcessInfo.processInfo.processName)
  }
  let window = makeWindow()
  manager.place(window, frame: nil)
  expect(window.frame == preferred, "A fresh process restores the user's saved window bounds")
  expect(!window.styleMask.contains(.fullScreen), "Restoration stays out of full screen")
  print("PASS: window bounds survive relaunch")
} else {
  NSWindow.removeFrame(usingName: "BrowserWindow")
  let first = makeWindow()
  manager.place(first, frame: nil)
  expect(first.frame == visible, "Without a preference the window fills the usable screen")
  expect(!first.styleMask.contains(.fullScreen), "Default maximization stays out of full screen")
  manager.windows["first"] = first
  manager.observeFrame(first)
  first.setFrame(preferred, display: false)
  expect(defaults.string(forKey: frameKey) != nil, "Programmatic resizing saves bounds without a live resize")
  manager.windows.removeAll()

  for _ in 0..<2 {
    let reopened = makeWindow()
    manager.place(reopened, frame: nil)
    expect(reopened.frame == preferred, "Reopening after all windows close restores bounds every time")
  }

  let saved = defaults.string(forKey: frameKey)
  for kind in ["small", "settings", "child"] {
    let other = makeWindow()
    manager.windows[kind] = other
    if kind == "small" { manager.smallIds.insert(kind) }
    if kind == "settings" { manager.auxKinds[kind] = kind }
    if kind == "child" { first.addChildWindow(other, ordered: .above) }
    manager.reportFrame(other)
    expect(defaults.string(forKey: frameKey) == saved, "\(kind) windows do not overwrite browser bounds")
    if kind == "child" { first.removeChildWindow(other) }
    manager.windows.removeValue(forKey: kind)
  }

  let explicit = makeWindow()
  let sessionFrame = NSRect(x: preferred.minX + 10, y: preferred.minY + 10,
                           width: preferred.width - 20, height: preferred.height - 20)
  manager.place(explicit, frame: [sessionFrame.minX, sessionFrame.minY, sessionFrame.width, sessionFrame.height])
  expect(explicit.frame == sessionFrame, "A session's explicit frame takes precedence over the saved default")
  manager.windows["source"] = explicit
  manager.lastPlaced = explicit
  let additional = makeWindow()
  manager.place(additional, frame: nil)
  expect(additional.frame.size == sessionFrame.size, "An additional window keeps the current browser window's size")
  defaults.synchronize()
  print("PASS: default maximization, resize persistence, repeated reopening, and window exclusions")
}
