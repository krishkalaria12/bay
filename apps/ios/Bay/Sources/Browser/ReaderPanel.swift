import BayCore
import BayDesign
import SwiftUI

/// Reader's settings, over the article it shows: leaving Reader, the text size, the font and the theme. Each change
/// restyles the article at once and is kept for the next one.
struct ReaderPanel: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel

  private static let fonts: [(ReaderFont, String)] = [(.serif, "reader.fontSerif"), (.sans, "reader.fontSans"), (.mono, "reader.fontMono")]

  var body: some View {
    let title = strings.t("reader.title")
    let settings = app.preferences.reader
    let steps = readerSizeSteps(size: settings.size)
    PanelSheet(title: title, testID: "reader-settings", words: strings.sheetWords(title), onClose: { browser.panel = nil }) {
      RowGroup {
        ActionRow(strings.t("reader.exit"), testID: "reader-exit", icon: .close, action: browser.exitReader)
      }
      SectionLabel(strings.t("reader.textSize"))
      HStack(spacing: Space.sm) {
        Choice(id: "reader-smaller", label: strings.t("reader.smaller"), disabled: !steps.smaller) {
          change { $0.size -= 1 }
        }
        BayText("\(settings.size)").frame(width: 40)
          .accessibilityLabel(Text(verbatim: "\(strings.t("reader.textSize")), \(settings.size)"))
          .accessibilityIdentifier("reader-size")
        Choice(id: "reader-larger", label: strings.t("reader.larger"), disabled: !steps.larger) {
          change { $0.size += 1 }
        }
      }
      SectionLabel(strings.t("reader.font"))
      HStack(spacing: Space.sm) {
        ForEach(Self.fonts, id: \.0) { font, key in
          Choice(id: "reader-font-\(font)", label: strings.t(key), selected: settings.font == font) { change { $0.font = font } }
        }
      }
      SectionLabel(strings.t("reader.theme"))
      HStack {
        ForEach(readerThemes(), id: \.id) { theme in
          let selected = settings.theme == theme.id
          Button { change { $0.theme = theme.id } } label: {
            Text(verbatim: "Aa").font(.system(size: TextVariant.subhead.size)).foregroundColor(hexColor(theme.text))
              .frame(width: 36, height: 36)
              .background(hexColor(theme.background), in: Circle())
              .overlay(Circle().stroke(Color.gray.opacity(0.35), lineWidth: 1))
              .padding(3)
              .overlay(Circle().stroke(selected ? BayColor.accent : .clear, lineWidth: 2))
          }
          .buttonStyle(PressFeedbackStyle())
          .accessibilityLabel(Text(verbatim: strings.t("reader.theme\(String(describing: theme.id).capitalized)")))
          .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
          .accessibilityIdentifier("reader-theme-\(theme.id)")
          if theme.id != readerThemes().last?.id { Spacer(minLength: 0) }
        }
      }
    }
  }

  private func change(_ edit: (inout ReaderSettings) -> Void) {
    var settings = app.preferences.reader
    edit(&settings)
    browser.changeReader(settings)
  }
}

/// One of a row of choices: a font, or a step of the text size.
private struct Choice: View {
  let id: String
  let label: String
  var selected = false
  var disabled = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      BayText(label, variant: .subhead)
        .frame(maxWidth: .infinity, minHeight: 44)
        .background(BayColor.fill, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.tile, style: .continuous).stroke(selected ? BayColor.accent : .clear, lineWidth: 2))
    }
    .buttonStyle(PressFeedbackStyle())
    .disabled(disabled)
    .opacity(disabled ? 0.4 : 1)
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier(id)
  }
}
