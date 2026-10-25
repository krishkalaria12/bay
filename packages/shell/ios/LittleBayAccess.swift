import AppKit
import Carbon.HIToolbox

/// Little Bay from any app, as Little Arc had it: a menu bar button and a global shortcut (Settings › Links), each
/// opening a Little Bay with its field ready to type, with Bay in the background or not. Both are off until chosen.
/// The shortcut is a Carbon hot key: it needs no Accessibility permission, and registering it exclusively says when
/// another app already has the key.
enum LittleBayAccess {
  private static var statusItem: NSStatusItem?
  private static var hotKey: EventHotKeyRef?
  private static var handler: EventHandlerRef?
  // "BayL": this app's hot keys.
  private static let signature: OSType = 0x4261_794C

  static func open() {
    NSApp.activate(ignoringOtherApps: true)
    MenuTarget.shared.handler?("newLittleBay", nil, nil)
  }

  static func setMenuBarItem(_ on: Bool) {
    guard on else {
      if let item = statusItem { NSStatusBar.system.removeStatusItem(item) }
      statusItem = nil
      return
    }
    guard statusItem == nil else { return }
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let image = NSImage(systemSymbolName: "macwindow.badge.plus", accessibilityDescription: "New Little Bay Window")
      ?? NSImage(systemSymbolName: "macwindow", accessibilityDescription: "New Little Bay Window")
    image?.isTemplate = true
    item.button?.image = image
    item.button?.toolTip = "New Little Bay Window"
    item.button?.target = MenuBarTarget.shared
    item.button?.action = #selector(MenuBarTarget.open(_:))
    statusItem = item
  }

  /// "ok", "off" (no key), or "taken": another app holds the key, or macOS refused it.
  static func setHotKey(keyCode: Int?, modifiers: [String]) -> String {
    if let hotKey { UnregisterEventHotKey(hotKey) }
    hotKey = nil
    guard let keyCode, keyCode >= 0 else { return "off" }
    installHandler()
    var mods: UInt32 = 0
    if modifiers.contains("command") { mods |= UInt32(cmdKey) }
    if modifiers.contains("option") { mods |= UInt32(optionKey) }
    if modifiers.contains("control") { mods |= UInt32(controlKey) }
    if modifiers.contains("shift") { mods |= UInt32(shiftKey) }
    var ref: EventHotKeyRef?
    let id = EventHotKeyID(signature: signature, id: 1)
    let status = RegisterEventHotKey(UInt32(keyCode), mods, id, GetApplicationEventTarget(), OptionBits(kEventHotKeyExclusive), &ref)
    guard status == noErr, let ref else { return "taken" }
    hotKey = ref
    return "ok"
  }

  private static func installHandler() {
    guard handler == nil else { return }
    var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
      var id = EventHotKeyID()
      let status = GetEventParameter(
        event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
      guard status == noErr, id.signature == LittleBayAccess.signature else { return OSStatus(eventNotHandledErr) }
      DispatchQueue.main.async { LittleBayAccess.open() }
      return noErr
    }, 1, &type, nil, &handler)
  }

  /// The Dock menu's Show / Hide All Little Bay Windows, while there are any.
  static func dockItem() -> NSMenuItem? {
    let windows = littleBayWindows()
    guard !windows.isEmpty else { return nil }
    let shown = windows.contains { $0.isVisible && !$0.isMiniaturized }
    let item = NSMenuItem(
      title: shown ? "Hide All Little Bay Windows" : "Show All Little Bay Windows",
      action: shown ? #selector(MenuBarTarget.hideAll(_:)) : #selector(MenuBarTarget.showAll(_:)), keyEquivalent: "")
    item.target = MenuBarTarget.shared
    return item
  }

  #if DEBUG
  static func devState(_ action: String?) -> [String: Any] {
    if action == "click" { statusItem?.button?.performClick(nil) }
    if action == "dock", let item = dockItem(), let selector = item.action { NSApp.sendAction(selector, to: item.target, from: item) }
    return [
      "menuBarItem": statusItem != nil,
      "hotKey": hotKey != nil,
      "dock": MainMenu.dockMenu().items.map(\.title),
      "visible": littleBayWindows().filter { $0.isVisible }.count,
    ]
  }
  #endif

  fileprivate static func littleBayWindows() -> [NSWindow] {
    WindowManager.shared.smallIds.sorted().compactMap { WindowManager.shared.windows[$0] }
  }
}

private final class MenuBarTarget: NSObject {
  static let shared = MenuBarTarget()
  @objc func open(_ sender: Any?) { LittleBayAccess.open() }

  @objc func hideAll(_ sender: Any?) {
    for window in LittleBayAccess.littleBayWindows() { window.orderOut(nil) }
  }

  @objc func showAll(_ sender: Any?) {
    NSApp.activate(ignoringOtherApps: true)
    for window in LittleBayAccess.littleBayWindows() {
      if window.isMiniaturized { window.deminiaturize(nil) }
      window.makeKeyAndOrderFront(nil)
    }
  }
}
