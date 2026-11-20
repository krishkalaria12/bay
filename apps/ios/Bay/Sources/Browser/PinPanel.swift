import BayCore
import BayDesign
import SwiftUI

/// A tab's sheet, from holding its card: the space it's in (another chip moves it there), how it's pinned (an
/// Essential, a pinned row, or a row in one of the space's folders, as the desktop's sidebar has them, with a new
/// folder made here), and closing it. The way it is pinned now is ticked; choosing it again unpins it.
struct PinPanel: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel
  let tab: BrowserTab
  @State private var naming = false

  var body: some View {
    let title = tab.title.isEmpty ? displayUrl(url: tab.url) : tab.title
    let pin = app.pins.first { $0.url == tab.url }
    PanelSheet(title: title, testID: "pin-menu", words: strings.sheetWords(title), onClose: { browser.panel = nil }) {
      if app.spaces.count > 1 {
        VStack(alignment: .leading, spacing: Space.sm) {
          BayText(strings.t("pin.spaces"), variant: .footnote, weight: .medium, tone: .muted).padding(.leading, Space.lg)
          SpaceChips(spaces: app.spaces, chosen: tab.spaceId) { id in
            browser.panel = nil
            browser.moveTab(tab, to: id)
          }
        }
        .padding(.bottom, Space.md)
      }
      RowGroup(strings.t("pin.pinAs")) {
        ActionRow(strings.t("pin.essential"), testID: "pin-menu-essential", icon: .bookmark, selected: pin?.kind == .essential) {
          browser.pin(tab, kind: .essential, folderId: nil)
        }
        RowDivider()
        ActionRow(strings.t("pin.row"), testID: "pin-menu-row", icon: .pin, selected: pin?.kind == .row && pin?.folderId == nil) {
          browser.pin(tab, kind: .row, folderId: nil)
        }
        ForEach(app.folders, id: \.id) { folder in
          RowDivider()
          ActionRow(
            strings.t("pin.into", ["folder": folder.name]), testID: "pin-menu-folder-\(folder.id)", icon: .folder,
            selected: pin?.kind == .row && pin?.folderId == folder.id
          ) { browser.pin(tab, kind: .row, folderId: folder.id) }
        }
        RowDivider()
        if naming {
          // A folder named here takes the tab straight in.
          FolderNameField(name: "", placeholder: strings.t("tabs.folderName")) { name in
            naming = false
            guard let name else { return }
            browser.pin(tab, kind: .row, folderId: browser.newFolder(name))
          }
          .padding(.horizontal, Space.sm)
          .padding(.vertical, Space.xs)
        } else {
          ActionRow(strings.t("tabs.newFolder"), testID: "pin-menu-new-folder", icon: .add) { naming = true }
        }
      }
      RowGroup {
        ActionRow(strings.t("pin.close"), testID: "pin-menu-close-tab", icon: .close, destructive: true) {
          browser.panel = nil
          browser.archive(tab.id)
        }
      }
      .padding(.top, Space.md)
    }
  }
}
