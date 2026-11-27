import BayCore
import BayDesign
import SwiftUI

extension Strings {
  /// The words a sheet's chrome needs, for a sheet titled `title`.
  func sheetWords(_ title: String) -> SheetWords {
    SheetWords(close: t("sheet.close", ["title": title]), back: t("sheet.back"), selected: t("sheet.selected"))
  }
}

/// Everything about a space in one sheet, as the desktop's space settings: its name, its colour, its emoji (from the
/// desktop's set, which it syncs as), its place in the bar, and deleting it with what it kept.
struct SpaceEditPanel: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @Environment(\.dynamicTypeSize) private var sizeCategory
  @ObservedObject var browser: BrowserModel
  let space: BrowserSpace
  @State private var name: String
  @State private var confirmingDelete = false

  private static let emoji = spaceEmoji()
  private static let colors = spaceColors()

  init(browser: BrowserModel, space: BrowserSpace) {
    self.browser = browser
    self.space = space
    _name = State(initialValue: space.name)
  }

  var body: some View {
    let shownName = spaceName(space, strings)
    let title = strings.t("space.edit.title", ["name": shownName])
    let index = app.spaces.firstIndex { $0.id == space.id } ?? 0
    let personal = space.id == "personal"
    PanelSheet(title: title, testID: "space-edit", words: strings.sheetWords(title), onClose: { browser.panel = nil }) {
      SectionLabel(strings.t("space.edit.name"))
      TextField(strings.t("space.edit.name"), text: $name)
        .font(TextVariant.body.font(sizeCategory: sizeCategory))
        .submitLabel(.done)
        .onSubmit(saveName)
        .padding(.horizontal, Space.lg)
        .padding(.vertical, 10)
        .background(BayColor.fill, in: Capsule())
        .accessibilityIdentifier("space-edit-name")

      SectionLabel(strings.t("space.edit.color"))
      HStack(spacing: Space.sm) {
        ForEach(Self.colors, id: \.self) { color in
          let chosen = color == space.color
          Button {
            browser.setSpaceColor(space.id, color)
          } label: {
            Circle().fill(spaceColor(color)).frame(width: 28, height: 28)
              .frame(width: 40, height: 40)
              .overlay(Circle().stroke(chosen ? spaceColor(color) : .clear, lineWidth: 2))
          }
          .buttonStyle(.pressFeedback)
          .accessibilityLabel(Text(verbatim: strings.t("space.color.\(color)")))
          .accessibilityAddTraits(chosen ? .isSelected : [])
          .accessibilityIdentifier("space-edit-color-\(color)")
        }
      }

      SectionLabel(strings.t("space.edit.icon"))
      LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Space.xs), count: 7), spacing: Space.xs) {
        ForEach(Array(Self.emoji.enumerated()), id: \.offset) { at, emoji in
          let chosen = emoji == space.icon
          Button {
            browser.setSpaceIcon(space.id, emoji)
          } label: {
            Text(verbatim: emoji).font(.system(size: 24))
              .frame(maxWidth: .infinity)
              .aspectRatio(1, contentMode: .fit)
              .background(chosen ? BayColor.accent.opacity(0.2) : BayColor.fill, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
          }
          .buttonStyle(.pressFeedback)
          .accessibilityLabel(Text(verbatim: emoji))
          .accessibilityAddTraits(chosen ? .isSelected : [])
          .accessibilityIdentifier("space-icon-\(at)")
        }
      }

      VStack(spacing: Space.lg) {
        RowGroup(strings.t("space.edit.order")) {
          ActionRow(strings.t("space.edit.moveLeft"), testID: "space-edit-move-left", icon: .back, disabled: index <= 0) {
            browser.moveSpace(space.id, by: -1)
          }
          RowDivider()
          ActionRow(strings.t("space.edit.moveRight"), testID: "space-edit-move-right", icon: .forward, disabled: index >= app.spaces.count - 1) {
            browser.moveSpace(space.id, by: 1)
          }
        }
        RowGroup {
          ActionRow(
            strings.t("space.edit.delete", ["name": shownName]), testID: "space-edit-delete", icon: .delete,
            detail: personal ? strings.t("space.edit.delete.personal") : strings.t("space.edit.delete.detail"), destructive: true,
            disabled: personal || app.spaces.count < 2
          ) { confirmingDelete = true }
        }
      }
      .padding(.top, Space.sm)
    }
    .alert(strings.t("space.edit.delete.title", ["name": shownName]), isPresented: $confirmingDelete) {
      Button(strings.t("space.edit.delete.cancel"), role: .cancel) {}
      Button(strings.t("space.edit.delete.action"), role: .destructive) { browser.deleteSpace(space.id) }
    } message: {
      Text(verbatim: strings.t("space.edit.delete.message"))
    }
  }

  private func saveName() {
    let trimmed = name.trimmingCharacters(in: .whitespaces)
    if !trimmed.isEmpty, trimmed != space.name { browser.renameSpace(space.id, trimmed) } else { name = space.name }
  }
}

/// A first-run tip: a card above the bar, with a ring round the control it means. It stays until "Got it", until the
/// control is used, or for a while.
struct TipCard: View {
  @EnvironmentObject private var strings: Strings
  let title: String
  let body_: String
  let onDone: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: Space.xs) {
      BayText(title, variant: .headline).accessibilityAddTraits(.isHeader)
      BayText(body_, variant: .subhead, tone: .muted)
      HStack {
        Spacer()
        Button(action: onDone) {
          BayText(strings.t("tip.gotIt"), variant: .subhead, weight: .semibold, color: BayColor.accentForeground)
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.sm)
            .background(BayColor.accentFill, in: Capsule())
        }
        .buttonStyle(.pressFeedback)
        .accessibilityIdentifier("tip-done")
      }
      .padding(.top, Space.sm)
    }
    .padding(Space.lg)
    .baySurface(radius: Radius.card)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("tip-capsule")
    .onAppear { UIAccessibility.post(notification: .announcement, argument: "\(title). \(body_)") }
  }
}
