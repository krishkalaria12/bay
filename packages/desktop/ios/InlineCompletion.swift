import AppKit
import ExpoModulesCore
import ObjectiveC

/// Apply text and selection together before the next key is handled.
public final class InlineCompletionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BayInlineCompletion")
    Events("onTextInputRestore")

    AsyncFunction("recordEdit") { (tag: Int, before: String, after: String, start: Int, end: Int, state: String) in
      guard let host = self.appContext?.findView(withTag: tag, ofType: NSView.self),
            let field = textField(in: host)
      else { return }
      let history = TextInputHistory.forField(field)
      history.onRestore = { [weak self] state in self?.sendEvent("onTextInputRestore", ["tag": tag, "state": state]) }
      history.record(before: before, after: after, selection: NSRange(location: start, length: max(0, end - start)), state: state)
    }.runOnQueue(.main)

    AsyncFunction("showMenu") { (tag: Int, items: [[String: Any]], promise: Promise) in
      guard let host = self.appContext?.findView(withTag: tag, ofType: NSView.self),
            let editor = textField(in: host)?.currentEditor() as? NSTextView
      else { promise.resolve(nil); return }
      let target = MenuChoice()
      let menu = Self.editingMenu(editor, items: items, target: target)
      menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
      DispatchQueue.main.async { promise.resolve(target.chosen) }
    }.runOnQueue(.main)

    AsyncFunction("complete") { (tag: Int, typed: String, completion: String) -> Int in
      guard let host = self.appContext?.findView(withTag: tag, ofType: NSView.self),
            let field = textField(in: host),
            let editor = field.currentEditor() as? NSTextView,
            !editor.hasMarkedText()
      else { return 0 }
      let text = editor.string as NSString
      let typedLength = (typed as NSString).length
      let selection = editor.selectedRange()
      guard text.length >= typedLength, text.substring(to: typedLength) == typed,
            selection.location == typedLength, NSMaxRange(selection) == text.length
      else { return 0 }
      let tail = NSRange(location: typedLength, length: text.length - typedLength)
      var result = 1
      if text.substring(with: tail) != completion {
        guard editor.shouldChangeText(in: tail, replacementString: completion) else { return 0 }
        editor.replaceCharacters(in: tail, with: completion)
        editor.didChangeText()
        result = 2
      }
      editor.setSelectedRange(NSRange(location: typedLength, length: (completion as NSString).length))
      editor.scrollRangeToVisible(NSRange(location: 0, length: 0))
      editor.scrollRangeToVisible(NSRange(location: typedLength, length: 0))
      return result
    }.runOnQueue(.main)
  }

  /// Use the field editor's own history and editing commands, as the Edit menu does.
  static func editingMenu(_ editor: NSTextView, items: [[String: Any]], target: MenuChoice) -> NSMenu {
    let menu = ShellModule.contextMenu(items, target: target)
    if !items.isEmpty { menu.addItem(.separator()) }
    let manager = TextInputHistory.undoManager(for: editor)
    let undo = NSMenuItem(title: "Undo", action: #selector(UndoManager.undo), keyEquivalent: "z")
    undo.target = manager
    undo.isEnabled = manager?.canUndo == true
    let redo = NSMenuItem(title: "Redo", action: #selector(UndoManager.redo), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    redo.target = manager
    redo.isEnabled = manager?.canRedo == true
    menu.insertItem(undo, at: 0)
    menu.insertItem(redo, at: 1)
    menu.insertItem(.separator(), at: 2)
    for (title, action, key) in [
      ("Cut", #selector(NSText.cut(_:)), "x"),
      ("Copy", #selector(NSText.copy(_:)), "c"),
      ("Paste", #selector(NSText.paste(_:)), "v"),
      ("Select All", #selector(NSText.selectAll(_:)), "a"),
    ] {
      if title == "Select All" { menu.addItem(.separator()) }
      let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
      item.target = editor
      item.isEnabled = editor.validateUserInterfaceItem(item)
      if action == #selector(NSText.paste(_:)) {
        let paste = TextInputPaste(editor)
        item.representedObject = paste
        item.target = paste
        item.action = #selector(TextInputPaste.paste(_:))
      }
      menu.addItem(item)
    }
    return menu
  }
}

/// AppKit records selected completion suffixes as deleted text. Keep whole typed values instead, with whatever else
/// the field's owner says belongs to them (`state`, opaque here), handed back through `onRestore` when it changes.
final class TextInputHistory: NSObject {
  private static var key: UInt8 = 0

  private struct Snapshot {
    let text: String
    let selection: NSRange
    let state: String
  }

  private weak var field: NSTextField?
  private let manager = UndoManager()
  var onRestore: ((String) -> Void)?
  private var current: Snapshot?
  private var run: (inserting: Bool, caret: Int)?
  /// Restored values whose change events are still on their way back from JS, oldest first.
  private var replaying: [String] = []

  init(_ field: NSTextField) {
    self.field = field
    manager.levelsOfUndo = 100
    manager.groupsByEvent = false
  }

  static func forField(_ field: NSTextField) -> TextInputHistory {
    if let history = objc_getAssociatedObject(field, &key) as? TextInputHistory { return history }
    let history = TextInputHistory(field)
    objc_setAssociatedObject(field, &key, history, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    return history
  }

  /// The field's own history while it's being edited, or else the editor's.
  static func undoManager(for editor: NSTextView) -> UndoManager? {
    let history = (editor.delegate as? NSTextField).flatMap { objc_getAssociatedObject($0, &key) as? TextInputHistory }
    return history?.manager ?? editor.undoManager
  }

  private func clamped(_ selection: NSRange, to text: String) -> NSRange {
    let count = (text as NSString).length
    let start = min(selection.location, count)
    return NSRange(location: start, length: min(selection.length, count - start))
  }

  /// What changed between two values, assuming it happened at `range` when given, which settles a repeated letter or a
  /// selection replaced by its own first letter.
  private struct Change {
    let location: Int
    let removed: String
    let added: String

    init(from before: String, to after: String, at range: NSRange? = nil) {
      let old = Array(before.utf16), new = Array(after.utf16)
      var head = 0
      while head < min(old.count, new.count, range?.location ?? .max), old[head] == new[head] { head += 1 }
      var tail = 0
      let kept = old.count - (range.map(NSMaxRange) ?? 0)
      while tail < min(min(old.count, new.count) - head, kept), old[old.count - 1 - tail] == new[new.count - 1 - tail] { tail += 1 }
      location = head
      removed = String(decoding: old[head..<(old.count - tail)], as: UTF16.self)
      added = String(decoding: new[head..<(new.count - tail)], as: UTF16.self)
    }

    var inserting: Bool { added.count == 1 }
    var keystroke: Bool { inserting || (added.isEmpty && removed.count == 1) }
    var removedRange: NSRange { NSRange(location: location, length: removed.utf16.count) }
    var caret: Int { location + added.utf16.count }

    /// Whether a key pressed with the caret at `caret` made this change.
    func continues(from caret: Int) -> Bool {
      if inserting { return removed.isEmpty && location == caret }
      return caret == location || caret == NSMaxRange(removedRange)
    }
  }

  /// `selection` is only a hint: the values alone say what changed, unless they could mean several things.
  func record(before: String, after: String, selection: NSRange, state: String) {
    if let index = replaying.firstIndex(of: after) { replaying.removeFirst(index + 1); return }
    let previous = current?.state ?? ""
    guard before != after || state != previous else { return }
    let next = (field?.currentEditor() as? NSTextView)?.selectedRange() ?? NSRange(location: (after as NSString).length, length: 0)
    current = Snapshot(text: after, selection: clamped(next, to: after), state: state)
    let selected = Change(from: before, to: after, at: clamped(selection, to: before))
    let readings = [
      selected,
      run.map { Change(from: before, to: after, at: NSRange(location: $0.caret, length: 0)) },
      Change(from: before, to: after),
    ]
    let change = readings.compactMap { $0 }.first(where: \.keystroke) ?? selected
    // Like a native field, one Undo takes back a whole run of typing or deleting at one caret.
    let typing = state == previous && change.keystroke
    var continues = false
    if typing, let run { continues = run.inserting == change.inserting && change.continues(from: run.caret) }
    run = typing ? (change.inserting, change.caret) : nil
    if !continues { register(Snapshot(text: before, selection: change.removedRange, state: previous)) }
  }

  private func register(_ snapshot: Snapshot) {
    let group = !manager.isUndoing && !manager.isRedoing
    if group { manager.beginUndoGrouping() }
    manager.registerUndo(withTarget: self) { $0.restore(snapshot) }
    if group { manager.endUndoGrouping() }
  }

  private func restore(_ snapshot: Snapshot) {
    guard let editor = field?.currentEditor() as? NSTextView, let current else { return }
    register(current)
    self.current = snapshot
    run = nil
    if snapshot.state != current.state { onRestore?(snapshot.state) }
    replaying.append(snapshot.text)
    editor.replaceCharacters(in: NSRange(location: 0, length: (editor.string as NSString).length), with: snapshot.text)
    editor.setSelectedRange(snapshot.selection)
    editor.didChangeText()
  }
}

private final class TextInputPaste: NSObject {
  let editor: NSTextView
  init(_ editor: NSTextView) { self.editor = editor }

  @objc func paste(_ sender: Any?) {
    guard let text = NSPasteboard.general.string(forType: .string) else { return }
    let normalized = text.replacingOccurrences(of: "\\s*\\n\\s*", with: " ", options: .regularExpression)
    editor.insertText(normalized, replacementRange: editor.selectedRange())
  }
}

private func textField(in view: NSView) -> NSTextField? {
  if let field = view as? NSTextField { return field }
  for sub in view.subviews {
    if let field = textField(in: sub) { return field }
  }
  return nil
}
