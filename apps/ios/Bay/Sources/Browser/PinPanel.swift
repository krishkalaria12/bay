import BayCore
import BayDesign
import SwiftUI

/// A tab's sheet, from holding its card, in the page menu's look: the tab's site and address on top; Share, Copy
/// link, Duplicate and Close as tiles; the space it's in (another chip moves it there); and how it's pinned, Off,
/// Essential or Pinned, with the space's folders under Pinned and a new one made there. Choices here keep the sheet
/// open, so the change shows; the tiles and moving the tab close it.
struct PinPanel: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel
  let tab: BrowserTab
  @State private var naming = false

  var body: some View {
    let title = tab.title.isEmpty ? displayUrl(url: tab.url) : tab.title
    let pin = app.pins.first { $0.url == tab.url }
    PanelSheet(
      title: title, testID: "pin-menu", words: strings.sheetWords(title), onClose: close,
      header: AnyView(TabHeader(tab: tab, title: title))
    ) {
      HStack(spacing: Space.sm) {
        MenuTile(id: "tab-sheet-share", icon: .share, label: strings.t("pageMenu.share")) {
          close()
          browser.share(tab.url)
        }
        MenuTile(id: "tab-sheet-copy", icon: .link, label: strings.t("pageMenu.copyLink")) {
          close()
          browser.copy(tab.url)
        }
        MenuTile(id: "tab-sheet-duplicate", icon: .copy, label: strings.t("tabSheet.duplicate")) {
          close()
          browser.duplicate(tab)
        }
        MenuTile(id: "pin-menu-close-tab", icon: .close, label: strings.t("tabSheet.close"), accessibilityLabel: strings.t("pin.close")) {
          close()
          browser.archive(tab.id)
        }
      }
      if app.spaces.count > 1 {
        section(strings.t("pin.spaces")) {
          SpaceChips(spaces: app.spaces, chosen: tab.spaceId) { id in
            guard id != tab.spaceId else { return }
            close()
            browser.moveTab(tab, to: id)
          }
        }
      }
      section(strings.t("pin.pinAs")) {
        PinKindPicker(kind: pin?.kind) { kind in
          browser.setPin(tab, kind: kind, folderId: kind == .row ? pin?.folderId : nil)
        }
        if pin?.kind == .row {
          BayText(strings.t("pin.folder"), variant: .footnote, weight: .medium, tone: .muted).padding(.top, Space.sm)
          if naming {
            // A folder named here takes the tab straight in.
            FolderNameField(name: "", placeholder: strings.t("tabs.folderName")) { name in
              naming = false
              guard let name else { return }
              browser.setPin(tab, kind: .row, folderId: browser.newFolder(name))
            }
          } else {
            folderChips(chosen: pin?.folderId)
          }
        }
      }
    }
  }

  private func close() {
    browser.panel = nil
  }

  /// A group with a small heading over it.
  private func section<Content: View>(_ heading: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      BayText(heading, variant: .footnote, weight: .medium, tone: .muted)
      content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.top, Space.lg)
  }

  /// None and the space's folders as chips, the one the pin is in filled, and a + for a new folder.
  private func folderChips(chosen: String?) -> some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: Space.sm) {
        chip(strings.t("pin.noFolder"), icon: nil, selected: chosen == nil, id: "pin-menu-folder-none") {
          browser.setPin(tab, kind: .row, folderId: nil)
        }
        ForEach(app.folders, id: \.id) { folder in
          chip(folder.name, icon: .folder, selected: chosen == folder.id, id: "pin-menu-folder-\(folder.id)") {
            browser.setPin(tab, kind: .row, folderId: folder.id)
          }
        }
        Button {
          naming = true
        } label: {
          BayIconView(.add, size: IconSize.small, color: BayColor.muted).frame(width: 36, height: 36).background(BayColor.fill, in: Circle())
        }
        .buttonStyle(.pressFeedback)
        .accessibilityLabel(Text(verbatim: strings.t("tabs.newFolder")))
        .accessibilityIdentifier("pin-menu-new-folder")
      }
    }
  }

  private func chip(_ label: String, icon: BayIcon?, selected: Bool, id: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: Space.xs) {
        if let icon { BayIconView(icon, size: IconSize.inline, color: selected ? .white : BayColor.foreground) }
        BayText(label, variant: .subhead, weight: .medium, color: selected ? .white : BayColor.foreground).lineLimit(1)
      }
      .padding(.horizontal, Space.md)
      .frame(height: 36)
      .background(selected ? BayColor.accent : BayColor.fill, in: Capsule())
    }
    .buttonStyle(.pressFeedback)
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier(id)
  }
}

/// The tab's site icon, title and address, where the page menu shows its address.
private struct TabHeader: View {
  let tab: BrowserTab
  let title: String

  var body: some View {
    HStack(spacing: Space.md) {
      SiteIcon(url: tab.url, size: 32)
      VStack(alignment: .leading, spacing: 2) {
        BayText(title, variant: .headline, weight: .semibold).lineLimit(1)
        BayText(displayUrl(url: tab.url), variant: .footnote, tone: .muted).lineLimit(1).truncationMode(.middle)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }
}

/// Off, Essential or Pinned in one control, the way the tab is pinned now filled.
private struct PinKindPicker: View {
  @EnvironmentObject private var strings: Strings
  let kind: PinKind?
  let choose: (PinKind?) -> Void

  var body: some View {
    HStack(spacing: 2) {
      segment(strings.t("pin.off"), nil, id: "pin-menu-off")
      segment(strings.t("pin.essentialShort"), .essential, id: "pin-menu-essential")
      segment(strings.t("pin.pinned"), .row, id: "pin-menu-row")
    }
    .padding(3)
    .background(BayColor.fill, in: Capsule())
    .animation(Motion.settle.animation, value: kind)
  }

  private func segment(_ label: String, _ value: PinKind?, id: String) -> some View {
    let selected = kind == value
    return Button {
      choose(value)
    } label: {
      BayText(label, variant: .subhead, weight: selected ? .semibold : .medium).lineLimit(1)
        .frame(maxWidth: .infinity, minHeight: 36)
        .background(selected ? BayColor.surface : .clear, in: Capsule())
        .shadow(color: .black.opacity(selected ? 0.12 : 0), radius: 4, y: 1)
        .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier(id)
  }
}
