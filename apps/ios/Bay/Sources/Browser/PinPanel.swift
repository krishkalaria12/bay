import BayCore
import BayDesign
import SwiftUI

/// A tab's pinning, from holding its card: an Essential, a pinned row, or a row in one of the space's folders, as the
/// desktop's sidebar has them. The way it is pinned now is ticked; choosing it again unpins it.
struct PinPanel: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel
  let tab: BrowserTab

  var body: some View {
    let title = tab.title.isEmpty ? displayUrl(url: tab.url) : tab.title
    let pin = app.pins.first { $0.url == tab.url }
    PanelSheet(title: title, testID: "pin-menu", words: strings.sheetWords(title), onClose: { browser.panel = nil }) {
      RowGroup {
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
