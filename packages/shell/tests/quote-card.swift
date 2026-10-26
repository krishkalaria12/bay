// Compiled with the production renderer by scripts/test-quote-card.py.
func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
  guard condition() else { fatalError(message) }
}

let url = "https://example.com/article#section:~:text=meaningful%20words"
let board = NSPasteboard.withUniqueName()
defer { board.releaseGlobally() }
let fixtures = [
  "A few meaningful words can change how we see the world.",
  "こんにちは、世界。 👩🏽‍💻 مرحباً بالعالم. A quote can cross languages.",
  String(repeating: "A longer passage wraps across lines without losing its words.\n", count: 55),
  String(repeating: "W", count: 4000),
]
for dark in [false, true] {
  for (index, text) in fixtures.enumerated() {
    let card = QuoteCard.render(text: text, title: "An article about meaningful words", url: url, colors: ["#B5556B", "#5F78BD"], dark: dark)!
    let bitmap = NSBitmapImageRep(data: card.png)!
    expect(bitmap.pixelsWide == 1440, "Card renders at 2x")
    expect(bitmap.pixelsHigh > 500 && bitmap.pixelsHigh < 12500, "Card fits all text within bounded dimensions")
    expect(card.copy(to: board), "Copy succeeds")
    expect(board.pasteboardItems?.count == 1, "Image and link are alternate representations of one item")
    expect(board.string(forType: .string) == url, "Plain text paste receives the fragment link")
    expect(board.string(forType: .URL) == url, "URL paste retains the fragment")
    expect(board.data(forType: .png) == card.png, "PNG data is preserved")
    expect(NSImage(pasteboard: board) != nil, "Image consumers can read the card")
    expect(board.data(forType: .tiff) != nil, "TIFF is available for native image consumers")
    if index == 0 {
      let plain = NSTextView()
      plain.isRichText = false
      plain.importsGraphics = false
      expect(plain.readSelection(from: board), "A plain text editor accepts the clipboard item")
      expect(plain.string == url, "A plain text editor pastes the source link")
      let rich = NSTextView()
      rich.isRichText = true
      rich.importsGraphics = true
      expect(rich.readSelection(from: board), "A rich text editor accepts the clipboard item")
      expect(rich.textStorage?.attribute(.attachment, at: 0, effectiveRange: nil) is NSTextAttachment, "A rich text editor pastes the image")
    }
    if CommandLine.arguments.count > 1 {
      try card.png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("quote-\(dark ? "dark" : "light")-\(index).png"))
    }
  }
}
expect(QuoteCard.render(text: " \n ", title: "", url: url, colors: [], dark: false) == nil, "Empty selections are rejected")
expect(QuoteCard.render(text: String(repeating: "a", count: 4001), title: "", url: url, colors: [], dark: false) == nil, "Oversized selections are rejected")
expect(QuoteCard.render(text: "a" + String(repeating: "\n", count: 3998) + "z", title: "", url: url, colors: [], dark: false) == nil, "Excessive image dimensions are rejected before allocating")
for scheme in ["file:///private/secret", "javascript:alert(1)", "bay://settings"] {
  expect(QuoteCard.render(text: "quote", title: "", url: scheme, colors: [], dark: false) == nil, "Only web sources are shared")
}
let fallback = QuoteCard.render(text: "quote", title: "", url: url, colors: ["invalid"], dark: true)!
expect(fallback.title == "example.com", "An untitled page uses its host")
print("Quote card rendering and clipboard checks passed")
