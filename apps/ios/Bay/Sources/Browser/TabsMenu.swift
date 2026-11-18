import BayCore
import BayDesign
import SwiftUI

/// Holding the Tabs button: quick tab actions, the spaces and the space's folders, without opening the switcher.
struct TabsMenu: View {
  enum Page { case main, move, newFolder, renameFolder }

  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel
  @State private var page = Page.main
  @State private var name = ""
  @FocusState private var naming: Bool

  var body: some View {
    switch page {
    case .main: main
    case .move: move
    case .newFolder, .renameFolder: folderName
    }
  }

  private func close() {
    browser.panel = nil
  }

  /// Closes the menu, then does what was picked.
  private func act(_ action: @escaping () -> Void) -> () -> Void {
    {
      close()
      action()
    }
  }

  private var main: some View {
    let title = strings.t("tabsMenu.title")
    let count = browser.switcherTabs.count
    let space = browser.activeSpace
    let selected = browser.activeFolderId
    return PanelSheet(title: title, testID: "tabs-menu", words: strings.sheetWords(title), onClose: close) {
      RowGroup {
        ActionRow(strings.t("tabsMenu.newTab"), testID: "tabs-menu-new", icon: .add, action: act { browser.search(inNewTab: true) })
        RowDivider()
        ActionRow(
          strings.t("tabsMenu.newPrivateTab"), testID: "tabs-menu-private", icon: .private,
          action: act { browser.search(inNewTab: true, privately: true) })
        RowDivider()
        ActionRow(strings.t("tabsMenu.archiveTab"), testID: "tabs-menu-archive", icon: .archive, action: act { browser.archive(app.activeTabId) })
        if count > 1 {
          RowDivider()
          ActionRow(
            strings.t("tabsMenu.archiveAll", ["count": "\(count)"]), testID: "tabs-menu-archive-all", icon: .archive, destructive: true,
            action: act(browser.archiveAll))
        }
      }
      RowGroup(strings.t("tabsMenu.spaces")) {
        ForEach(app.spaces, id: \.id) { item in
          ActionRow(
            spaceName(item, strings), testID: "tabs-menu-space-\(item.id)", selected: item.id == app.activeSpaceId,
            action: act { browser.selectSpace(item.id) })
          RowDivider(afterIcon: false)
        }
        ActionRow(strings.t("tabsMenu.newSpace"), testID: "tabs-menu-new-space", icon: .add, action: act(browser.newSpace))
        if let space {
          RowDivider()
          ActionRow(
            strings.t("tabsMenu.editSpace", ["name": spaceName(space, strings)]), testID: "tabs-menu-edit-space", icon: .tune
          ) { browser.panel = .spaceEdit }
        }
      }
      RowGroup(strings.t("tabsMenu.moveTab")) {
        ActionRow(strings.t("tabsMenu.moveTabTo"), testID: "tabs-menu-move", chevron: true) { page = .move }
      }
      RowGroup(strings.t("tabsMenu.folders")) {
        if app.folders.isEmpty {
          ActionRow(strings.t("tabsMenu.noFolders"), testID: "tabs-menu-folders-empty") { startNaming(.newFolder) }
          RowDivider(afterIcon: false)
        } else {
          ForEach(app.folders, id: \.id) { folder in
            ActionRow(folder.name, testID: "tabs-menu-folder-\(folder.id)", selected: folder.id == selected) {
              browser.activeFolderId = folder.id
            }
            RowDivider(afterIcon: false)
          }
        }
        ActionRow(strings.t("tabsMenu.newFolder"), testID: "tabs-menu-new-folder", icon: .add) { startNaming(.newFolder) }
        if let selected {
          RowDivider()
          ActionRow(strings.t("tabsMenu.renameFolder"), testID: "tabs-menu-rename-folder") { startNaming(.renameFolder) }
          RowDivider(afterIcon: false)
          ActionRow(
            strings.t("tabsMenu.deleteFolder"), testID: "tabs-menu-delete-folder", detail: strings.t("tabsMenu.deleteFolder.detail"),
            destructive: true, action: act { browser.deleteFolder(selected) })
        }
      }
      .padding(.bottom, Space.sm)
    }
  }

  private var move: some View {
    let title = strings.t("tabsMenu.moveTab")
    return PanelSheet(title: title, testID: "tabs-menu", words: strings.sheetWords(title), onClose: close, onBack: { page = .main }) {
      RowGroup(strings.t("tabsMenu.spaces")) {
        ForEach(Array(app.spaces.enumerated()), id: \.element.id) { index, space in
          if index > 0 { RowDivider(afterIcon: false) }
          ActionRow(
            spaceName(space, strings), testID: "tabs-menu-move-space-\(space.id)", selected: space.id == app.activeSpaceId,
            action: act { browser.moveActiveTab(spaceId: space.id, folderId: nil) })
        }
      }
      if !app.folders.isEmpty {
        RowGroup(strings.t("tabsMenu.folders")) {
          ForEach(Array(app.folders.enumerated()), id: \.element.id) { index, folder in
            if index > 0 { RowDivider(afterIcon: false) }
            ActionRow(
              folder.name, testID: "tabs-menu-move-folder-\(folder.id)", selected: folder.id == browser.activeFolderId,
              action: act { browser.moveActiveTab(spaceId: app.activeSpaceId, folderId: folder.id) })
          }
        }
      }
    }
  }

  /// A new folder's name, or the chosen folder's new one: one field, inside this same sheet.
  private var folderName: some View {
    let current = app.folders.first { $0.id == browser.activeFolderId }?.name
    let title =
      page == .newFolder
      ? strings.t("tabsMenu.newFolderTitle") : current.map { strings.t("tabsMenu.rename", ["name": $0]) } ?? strings.t("tabsMenu.renameFolder")
    return PanelSheet(title: title, testID: "tabs-menu", words: strings.sheetWords(title), onClose: close, onBack: { page = .main }) {
      TextField(title, text: $name)
        .focused($naming)
        .submitLabel(.done)
        .onSubmit(save)
        .padding(.horizontal, Space.lg)
        .frame(minHeight: 44)
        .background(BayColor.fill, in: Capsule())
        .padding(.top, Space.xs)
        .accessibilityIdentifier("tabs-menu-name")
      ActionRow(strings.t("tabsMenu.done"), testID: "tabs-menu-name-save", action: save)
        .padding(.top, Space.sm)
    }
    .onAppear { naming = true }
  }

  private func startNaming(_ next: Page) {
    name = next == .renameFolder ? app.folders.first { $0.id == browser.activeFolderId }?.name ?? "" : ""
    page = next
  }

  private func save() {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      page = .main
      return
    }
    if page == .newFolder {
      browser.newFolder(trimmed)
    } else if let id = browser.activeFolderId {
      browser.renameFolder(id, trimmed)
    }
    page = .main
  }
}

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
