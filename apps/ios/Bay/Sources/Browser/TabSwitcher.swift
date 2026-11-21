import BayCore
import BayDesign
import SwiftUI

/// A space's colour: its glyph, its dot in the bar and the wash at the top of its page.
func spaceColor(_ color: SpaceColor) -> Color {
  switch color {
  case .gray: return Color(RGBA(0x9C, 0xA3, 0xAF))
  case .blue: return Color(RGBA(0x3B, 0x82, 0xF6))
  case .green: return Color(RGBA(0x22, 0xC5, 0x5E))
  case .orange: return Color(RGBA(0xF9, 0x73, 0x16))
  case .red: return Color(RGBA(0xEF, 0x44, 0x44))
  case .violet: return Color(RGBA(0x8B, 0x5C, 0xF6))
  }
}

/// A space's name as the user sees it: the first space shows in the current language while it keeps its first name.
@MainActor func spaceName(_ space: BrowserSpace, _ strings: Strings) -> String {
  space.id == "personal" && space.name == "Personal" ? strings.t("space.personal") : space.name
}

/// A space's mark: its emoji, or its first letter on its colour in a rounded square.
struct SpaceGlyph: View {
  let space: BrowserSpace
  let name: String
  let size: CGFloat

  var body: some View {
    Group {
      if let icon = space.icon {
        Text(verbatim: icon).font(.system(size: size * 0.82)).frame(width: size, height: size)
      } else {
        Text(verbatim: String(name.trimmingCharacters(in: .whitespaces).first ?? "•").uppercased())
          .font(.system(size: size * 0.5, weight: .bold))
          .foregroundColor(.white)
          .frame(width: size, height: size)
          .background(spaceColor(space.color), in: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
      }
    }
    .accessibilityHidden(true)
  }
}

/// The tab view as a space's page: its name over a wash of its colour, the pinned sites, its folders, and its tabs as
/// a grid of cards. A sideways swipe moves to the next space, the page following the finger with the next space drawn
/// beside it and the colours blending; past the first or last space it stretches. The bar below switches spaces too.
struct TabSwitcher: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel
  let onSettings: () -> Void
  @State private var shift: CGFloat = 0
  /// Folders opened or closed by a tap; one not tapped yet is open when it holds the page showing.
  @State private var folderToggles: [String: Bool] = [:]
  /// A folder name being typed: a new folder, or one being renamed where it sits.
  @State private var naming: FolderNaming?
  /// A pin or a folder held without moving, whose actions are offered.
  @State private var pinActions: PinnedSite?
  @State private var folderActions: BrowserFolder?
  /// The pinned row being dragged, how far it has come, and what it would land on ("top", "folder:<id>", "pin:<id>").
  @State private var draggingPin: String?
  @State private var pinLift: CGFloat = 0
  @State private var pinTarget: String?
  @State private var pinFrames: [String: CGRect] = [:]
  /// The folder being dragged among the others, how far it has come, and the folder it would land beside.
  @State private var draggingFolder: String?
  @State private var folderLift: CGFloat = 0
  @State private var folderTarget: String?

  private static let columns = 2
  private static let essentialColumns = 3
  private static let gap: CGFloat = 10
  /// A card is a little taller than wide, like a phone's page shrunk down.
  private static let cardRatio: CGFloat = 1.32

  var body: some View {
    let spaces = app.spaces
    let index = spaces.firstIndex { $0.id == app.activeSpaceId }
    let space = index.map { spaces[$0] } ?? spaces.first
    let color = spaceColor(space?.color ?? .gray)
    let tabs = browser.switcherTabs
    let essentials = app.pins.filter { $0.kind == .essential }
    let rows = app.pins.filter { $0.kind == .row }
    let hasPinned = !rows.isEmpty || !app.folders.isEmpty || naming != nil
    // The space the swipe is pulling in, and how far it has come.
    let coming = neighbour(index, toward: shift)
    let progress = coming == nil ? 0 : min(1, abs(shift) / Self.pageWidth)
    ZStack(alignment: .top) {
      wash(color).opacity(1 - progress)
      if let coming { wash(spaceColor(coming.color)).opacity(progress) }
      GeometryReader { geometry in
        let inner = geometry.size.width - 2 * Space.gutter
        let cardWidth = floor((inner - Self.gap * CGFloat(Self.columns - 1)) / CGFloat(Self.columns))
        let essentialWidth = floor((inner - Self.gap * CGFloat(Self.essentialColumns - 1)) / CGFloat(Self.essentialColumns))
        ScrollViewReader { reader in
        ScrollView(showsIndicators: false) {
          VStack(alignment: .leading, spacing: Space.lg) {
            if let space { header(space) }
            if !essentials.isEmpty { essentialTiles(essentials, width: essentialWidth) }
            if hasPinned { pinnedRows(rows) }
            if !tabs.isEmpty || (essentials.isEmpty && rows.isEmpty) { countRow(tabs.count) }
            LazyVGrid(
              columns: Array(repeating: GridItem(.fixed(cardWidth), spacing: Self.gap), count: Self.columns), alignment: .leading,
              spacing: Space.lg
            ) {
              ForEach(Array(tabs.enumerated()), id: \.element.id) { index, tab in
                TabCard(
                  tab: tab, index: index, count: tabs.count, width: cardWidth, height: (cardWidth * Self.cardRatio).rounded(),
                  active: tab.id == app.activeTabId, browser: browser)
              }
            }
          }
          .padding(.horizontal, Space.gutter)
          .padding(.top, Space.sm)
          .padding(.bottom, 52 + Space.xxl)
        }
        // Opened from a page, on that page's card, so the page has its card to shrink into.
        .onAppear {
          if browser.opening != nil { reader.scrollTo(app.activeTabId, anchor: .center) }
        }
        }
        .offset(x: shift)
        if shift != 0, let index {
          let cardHeight = (cardWidth * Self.cardRatio).rounded()
          if index > 0 {
            SpacePreview(space: spaces[index - 1], cardWidth: cardWidth, cardHeight: cardHeight, gap: Self.gap, columns: Self.columns)
              .offset(x: shift - geometry.size.width)
          }
          if index < spaces.count - 1 {
            SpacePreview(space: spaces[index + 1], cardWidth: cardWidth, cardHeight: cardHeight, gap: Self.gap, columns: Self.columns)
              .offset(x: shift + geometry.size.width)
          }
        }
      }
    }
    // Beside the list's scrolling: as a plain gesture it only heard the drag once the list let go, at its end.
    .simultaneousGesture(spaceSwipe)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("tab-switcher")
  }

  /// The tab view's width, which a swipe across it moves a whole space by.
  private static var pageWidth: CGFloat { UIScreen.main.bounds.width }

  /// A space's wash of colour at the top of its page.
  private func wash(_ color: Color) -> some View {
    LinearGradient(
      stops: [.init(color: color.opacity(0.34), location: 0), .init(color: color.opacity(0.08), location: 0.55), .init(color: color.opacity(0), location: 1)],
      startPoint: .top, endPoint: .bottom
    )
    .ignoresSafeArea()
    .allowsHitTesting(false)
  }

  /// The space beside the one at `index` on the side a swipe of `shift` pulls in: the next one for a swipe left.
  private func neighbour(_ index: Int?, toward shift: CGFloat) -> BrowserSpace? {
    guard let index, shift != 0 else { return nil }
    let next = index + (shift < 0 ? 1 : -1)
    return app.spaces.indices.contains(next) ? app.spaces[next] : nil
  }

  /// A sideways swipe follows the finger to the next space or the one before, and goes there once it's far or quick
  /// enough; with no space that way the page stretches and springs back.
  private var spaceSwipe: some Gesture {
    DragGesture(minimumDistance: 24)
      .onChanged { value in
        let dx = value.translation.width
        guard abs(dx) > abs(value.translation.height) else { return }
        let index = app.spaces.firstIndex { $0.id == app.activeSpaceId }
        shift = neighbour(index, toward: dx) == nil ? stretch(dx) : dx
      }
      .onEnded { value in
        let dx = value.translation.width
        let width = Self.pageWidth
        let index = app.spaces.firstIndex { $0.id == app.activeSpaceId }
        let far = abs(dx) > width * 0.3 || abs(value.predictedEndTranslation.width) > width * 0.6
        guard abs(dx) > abs(value.translation.height), far, let next = neighbour(index, toward: dx) else {
          withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { shift = 0 }
          return
        }
        Haptics.tick()
        withAnimation(.easeOut(duration: 0.2)) { shift = dx < 0 ? -width : width }
        // Once the next space covers the screen it becomes the one showing, in place.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
          var still = Transaction()
          still.disablesAnimations = true
          withTransaction(still) {
            browser.selectSpace(next.id)
            shift = 0
          }
        }
      }
  }

  /// How far a page moves when pulled past the last space: less the further it goes, as a scroll view's edge does.
  private func stretch(_ dx: CGFloat) -> CGFloat {
    let width = Self.pageWidth
    let pulled = (1 - 1 / (abs(dx) * 0.55 / width + 1)) * width
    return dx < 0 ? -pulled : pulled
  }

  private func header(_ space: BrowserSpace) -> some View {
    let name = spaceName(space, strings)
    return HStack(spacing: Space.sm) {
      Button {
        browser.panel = .spaceEdit
      } label: {
        HStack(spacing: Space.sm) {
          SpaceGlyph(space: space, name: name, size: 30)
          BayText(name, variant: .title).lineLimit(1)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("tab-switcher-space")
          Spacer(minLength: 0)
        }
      }
      .buttonStyle(.pressFeedback)
      .accessibilityLabel(Text(verbatim: strings.t("space.edit.title", ["name": name])))
      .accessibilityIdentifier("tab-switcher-icon")
      Button(action: onSettings) {
        BayIconView(.settings, size: IconSize.small, color: BayColor.muted)
          .frame(width: 40, height: 40)
          .background(BayColor.fill, in: Circle())
      }
      .buttonStyle(.pressFeedback)
      .accessibilityLabel(Text(verbatim: strings.t("bar.settings")))
      .accessibilityIdentifier("tab-switcher-settings")
    }
    .frame(minHeight: 44)
  }

  private func essentialTiles(_ pins: [PinnedSite], width: CGFloat) -> some View {
    let activeUrl = browser.activeTab?.url
    return LazyVGrid(columns: Array(repeating: GridItem(.fixed(width), spacing: Self.gap), count: Self.essentialColumns), spacing: Self.gap) {
      ForEach(Array(pins.enumerated()), id: \.element.id) { index, pin in
        let active = pin.url == activeUrl
        SiteIcon(url: pin.url, size: 30)
          .frame(width: width, height: 64)
          .background(BayColor.fill, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: Radius.tile, style: .continuous).stroke(active ? BayColor.accent : .clear, lineWidth: 2))
          .contentShape(Rectangle())
          .onTapGesture { browser.openPin(pin) }
          .onLongPressGesture {
            Haptics.tick()
            pinActions = pin
          }
          .accessibilityElement()
          .accessibilityAddTraits(active ? [.isButton, .isSelected] : .isButton)
          .accessibilityLabel(Text(verbatim: pin.title.isEmpty ? displayUrl(url: pin.url) : pin.title))
          .accessibilityHint(Text(verbatim: strings.t("pin.holdHint")))
          .accessibilityAction(named: Text(verbatim: strings.t("pin.unpin"))) { unpin(pin) }
          .accessibilityIdentifier("tab-essential-\(index)")
      }
    }
  }

  /// The pinned rows, loose ones first and then the folders, under "Pinned" with a + for a new folder. Holding a row
  /// lifts it to drag into a folder, out of one (onto "Pinned"), or beside another; let go where it was, its actions
  /// are offered. Holding a folder offers Rename and Delete.
  private func pinnedRows(_ rows: [PinnedSite]) -> some View {
    let activeUrl = browser.activeTab?.url
    let loose = rows.filter { $0.folderId == nil }
    let folders = app.folders.map { folder in (folder, rows.filter { $0.folderId == folder.id }) }
    let visible = loose.map(\.id) + folders.flatMap { folder, inside in isOpen(folder.id, inside, activeUrl) ? inside.map(\.id) : [] }
    return VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: Space.sm) {
        BayText(strings.t("tabs.pinned"), variant: .footnote, weight: .medium, tone: .overWallpaper)
        Spacer(minLength: 0)
        Button {
          Haptics.press()
          naming = .new
        } label: {
          BayIconView(.add, size: IconSize.inline, color: BayColor.muted).frame(width: 44, height: 32).contentShape(Rectangle())
        }
        .buttonStyle(.pressFeedback)
        .accessibilityLabel(Text(verbatim: strings.t("tabs.newFolder")))
        .accessibilityIdentifier("tab-pinned-new-folder")
      }
      .padding(.leading, Space.sm)
      .background(dropWash(pinTarget == "top"))
      .background(frame("top"))
      ForEach(loose, id: \.id) { row in pinRow(row, indent: false, visible: visible) }
      ForEach(folders, id: \.0.id) { folder, inside in
        if naming == .rename(folder.id) {
          FolderNameField(name: folder.name, placeholder: strings.t("tabs.folderName")) { name in
            naming = nil
            if let name, name != folder.name { browser.renameFolder(folder.id, name) }
          }
        } else {
          folderRow(folder, count: inside.count, open: isOpen(folder.id, inside, activeUrl))
        }
        if isOpen(folder.id, inside, activeUrl) {
          ForEach(inside, id: \.id) { row in pinRow(row, indent: true, visible: visible) }
        }
      }
      if naming == .new {
        FolderNameField(name: "", placeholder: strings.t("tabs.folderName")) { name in
          naming = nil
          if let name { browser.newFolder(name) }
        }
      }
    }
    .coordinateSpace(name: "pinned")
    .onPreferenceChange(PinFrames.self) { pinFrames = $0 }
    .confirmationDialog(
      pinActions.map { $0.title.isEmpty ? displayUrl(url: $0.url) : $0.title } ?? "",
      isPresented: Binding(get: { pinActions != nil }, set: { if !$0 { pinActions = nil } }), titleVisibility: .visible,
      presenting: pinActions
    ) { pin in
      if pin.kind == .essential {
        Button(strings.t("pin.makeRow")) { browser.movePin(pin, kind: .row, folderId: nil) }
      } else {
        if let folder = app.folders.first(where: { $0.id == pin.folderId }) {
          Button(strings.t("pin.takeOut", ["folder": folder.name])) { browser.movePin(pin, kind: .row, folderId: nil) }
        }
        ForEach(app.folders.filter { $0.id != pin.folderId }, id: \.id) { folder in
          Button(strings.t("pin.moveTo", ["folder": folder.name])) {
            browser.movePin(pin, kind: .row, folderId: folder.id)
            folderToggles[folder.id] = true
          }
        }
      }
      Button(strings.t("pin.unpin"), role: .destructive) { unpin(pin) }
      Button(strings.t("tabs.cancel"), role: .cancel) {}
    }
    .confirmationDialog(
      folderActions?.name ?? "", isPresented: Binding(get: { folderActions != nil }, set: { if !$0 { folderActions = nil } }),
      titleVisibility: .visible, presenting: folderActions
    ) { folder in
      // After the dialog has gone, so the field can take the keyboard.
      Button(strings.t("tabs.renameFolder")) { DispatchQueue.main.async { naming = .rename(folder.id) } }
      Button(strings.t("tabs.deleteFolder"), role: .destructive) { browser.deleteFolder(folder.id) }
      Button(strings.t("tabs.cancel"), role: .cancel) {}
    } message: { _ in
      Text(verbatim: strings.t("tabs.deleteFolder.detail"))
    }
  }

  /// A folder being dragged shows closed, so only its row moves.
  private func isOpen(_ id: String, _ inside: [PinnedSite], _ activeUrl: String?) -> Bool {
    draggingFolder != id && (folderToggles[id] ?? inside.contains { $0.url == activeUrl })
  }

  /// A pinned folder: a row that opens to show the pinned rows in it, as the desktop's Pinned folders do.
  private func folderRow(_ folder: BrowserFolder, count: Int, open: Bool) -> some View {
    let lifted = draggingFolder == folder.id
    let index = app.folders.firstIndex { $0.id == folder.id } ?? 0
    return HStack(spacing: Space.md) {
      BayIconView(.folder, size: IconSize.small)
      BayText(folder.name, variant: .callout).lineLimit(1)
      Spacer(minLength: 0)
      BayText(count == 0 ? "" : "\(count)", variant: .footnote, tone: .overWallpaper)
      BayIconView(.chevron, size: IconSize.inline, color: BayColor.muted).rotationEffect(.degrees(open ? 90 : 0))
    }
    .padding(.horizontal, Space.sm)
    .frame(minHeight: 40)
    .background(dropWash(pinTarget == "folder:\(folder.id)" || folderTarget == folder.id))
    // Solid while it's carried, so the row it passes over doesn't show through.
    .background(lifted ? BayColor.surface : .clear, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
    .scaleEffect(lifted ? 1.03 : 1)
    .shadow(color: .black.opacity(lifted ? 0.2 : 0), radius: 10, y: 5)
    .contentShape(Rectangle())
    .onTapGesture {
      guard draggingFolder == nil else { return }
      withAnimation(.easeOut(duration: Motion.tap)) { folderToggles[folder.id] = !open }
    }
    .background(frame("folder:\(folder.id)"))
    .offset(y: lifted ? folderLift : 0)
    .zIndex(lifted ? 1 : 0)
    .gesture(folderHold(folder))
    .accessibilityElement(children: .ignore)
    .accessibilityAddTraits(.isButton)
    .accessibilityLabel(Text(verbatim: folder.name))
    .accessibilityValue(Text(verbatim: open ? "expanded" : "collapsed"))
    .accessibilityAction(.default) { folderToggles[folder.id] = !open }
    .accessibilityAction(named: Text(verbatim: strings.t("tabs.renameFolder"))) { naming = .rename(folder.id) }
    .accessibilityAction(named: Text(verbatim: strings.t("tabs.deleteFolder"))) { browser.deleteFolder(folder.id) }
    .modifier(FolderOrderActions(folders: app.folders, index: index, browser: browser))
    .accessibilityIdentifier("tab-folder-\(folder.id)")
  }

  /// Holding a folder: moved, it lifts and follows the finger and lands before or after the folder it's let go on;
  /// let go where it was, Rename and Delete are offered.
  private func folderHold(_ folder: BrowserFolder) -> some Gesture {
    LongPressGesture(minimumDuration: 0.4)
      .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .named("pinned")))
      .onChanged { value in
        guard case .second(true, let drag) = value else { return }
        guard let drag else {
          Haptics.press()
          return
        }
        if draggingFolder == nil, abs(drag.translation.height) > 8 {
          draggingFolder = folder.id
          Haptics.tick()
        }
        guard draggingFolder == folder.id else { return }
        folderLift = drag.translation.height
        let over = pinFrames.first { key, frame in
          key.hasPrefix("folder:") && key != "folder:\(folder.id)" && frame.minY <= drag.location.y && drag.location.y < frame.maxY
        }.map { String($0.key.dropFirst("folder:".count)) }
        if over != folderTarget {
          folderTarget = over
          if over != nil { UISelectionFeedbackGenerator().selectionChanged() }
        }
      }
      .onEnded { value in
        guard case .second(true, _) = value else { return }
        guard draggingFolder == folder.id else {
          folderActions = folder
          return
        }
        if let target = folderTarget {
          let from = app.folders.firstIndex { $0.id == folder.id } ?? 0
          let to = app.folders.firstIndex { $0.id == target } ?? 0
          browser.moveFolder(folder.id, beside: target, after: from < to)
        }
        withAnimation(Motion.settle.animation) {
          folderLift = 0
          draggingFolder = nil
          folderTarget = nil
        }
      }
  }

  private func pinRow(_ row: PinnedSite, indent: Bool, visible: [String]) -> some View {
    let active = row.url == browser.activeTab?.url
    let lifted = draggingPin == row.id
    return HStack(spacing: Space.md) {
      SiteIcon(url: row.url, size: 20)
      BayText(row.title.isEmpty ? displayUrl(url: row.url) : row.title, variant: .callout, weight: active ? .semibold : .regular)
        .lineLimit(1)
      Spacer(minLength: 0)
    }
    .padding(.leading, indent ? Space.xl + Space.sm : Space.sm)
    .padding(.trailing, Space.sm)
    .frame(minHeight: 40)
    .background(
      pinTarget == "pin:\(row.id)" ? BayColor.accent.opacity(0.25) : lifted ? BayColor.surface : active ? BayColor.fill : .clear,
      in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
    )
    .scaleEffect(lifted ? 1.03 : 1)
    .shadow(color: .black.opacity(lifted ? 0.2 : 0), radius: 10, y: 5)
    .contentShape(Rectangle())
    .onTapGesture {
      guard draggingPin == nil else { return }
      browser.openPin(row)
    }
    .background(frame("pin:\(row.id)"))
    .offset(y: lifted ? pinLift : 0)
    .zIndex(lifted ? 1 : 0)
    .gesture(pinHold(row, visible: visible))
    .accessibilityElement(children: .ignore)
    .accessibilityAddTraits(active ? [.isButton, .isSelected] : .isButton)
    .accessibilityLabel(Text(verbatim: row.title.isEmpty ? displayUrl(url: row.url) : row.title))
    .accessibilityHint(Text(verbatim: strings.t("pin.holdHint")))
    .accessibilityAction(.default) { browser.openPin(row) }
    .accessibilityAction(named: Text(verbatim: strings.t("pin.unpin"))) { unpin(row) }
    .accessibilityIdentifier("tab-pinned-\(row.id)")
  }

  private func pinHold(_ row: PinnedSite, visible: [String]) -> some Gesture {
    LongPressGesture(minimumDuration: 0.4)
      .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .named("pinned")))
      .onChanged { value in
        guard case .second(true, let drag) = value else { return }
        guard let drag else {
          Haptics.press()
          return
        }
        if draggingPin == nil, abs(drag.translation.height) > 8 {
          draggingPin = row.id
          Haptics.tick()
        }
        guard draggingPin == row.id else { return }
        pinLift = drag.translation.height
        let over = pinFrames.first { $0.key != "pin:\(row.id)" && $0.value.minY <= drag.location.y && drag.location.y < $0.value.maxY }?.key
        if over != pinTarget {
          pinTarget = over
          if over != nil { UISelectionFeedbackGenerator().selectionChanged() }
        }
      }
      .onEnded { value in
        guard case .second(true, _) = value else { return }
        guard draggingPin == row.id else {
          pinActions = row
          return
        }
        if let pinTarget { drop(row, on: pinTarget, visible: visible) }
        withAnimation(Motion.settle.animation) {
          pinLift = 0
          draggingPin = nil
          pinTarget = nil
        }
      }
  }

  /// A dragged pinned row let go over `target`: onto "Pinned" it comes out of its folder, onto a folder it goes in,
  /// onto another row it goes beside it, in that row's folder (after it when dragged down to it).
  private func drop(_ row: PinnedSite, on target: String, visible: [String]) {
    if target == "top" {
      browser.movePin(row, kind: .row, folderId: nil)
    } else if target.hasPrefix("folder:") {
      let id = String(target.dropFirst("folder:".count))
      browser.movePin(row, kind: .row, folderId: id)
      folderToggles[id] = true
    } else if target.hasPrefix("pin:") {
      let id = String(target.dropFirst("pin:".count))
      guard let beside = app.pins.first(where: { $0.id == id }) else { return }
      let after = (visible.firstIndex(of: row.id) ?? 0) < (visible.firstIndex(of: id) ?? 0)
      browser.movePin(row, kind: .row, folderId: beside.folderId, beside: id, after: after)
    }
  }

  /// The wash on what a dragged row would land on.
  private func dropWash(_ on: Bool) -> some View {
    RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(BayColor.accent.opacity(on ? 0.25 : 0))
  }

  /// Reports where a pinned row, folder or the heading sits, for a dragged row to find what it's over.
  private func frame(_ key: String) -> some View {
    GeometryReader { proxy in Color.clear.preference(key: PinFrames.self, value: [key: proxy.frame(in: .named("pinned"))]) }
  }

  private func countRow(_ count: Int) -> some View {
    HStack(spacing: Space.md) {
      BayText(count == 1 ? strings.t("tabs.one") : strings.t("tabs.count", ["count": "\(count)"]), variant: .footnote, weight: .medium, tone: .overWallpaper)
        .accessibilityIdentifier("tab-switcher-count")
      Rectangle().fill(BayColor.foreground.opacity(0.1)).frame(height: 1 / UIScreen.main.scale)
      if count > 1 {
        Button {
          Haptics.tick()
          browser.archiveAll()
        } label: {
          BayText(strings.t("tabs.clear"), variant: .footnote, weight: .medium, tone: .overWallpaper)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressFeedback)
        .accessibilityLabel(Text(verbatim: strings.t("tabs.archiveAllCount", ["count": "\(count)"])))
        .accessibilityIdentifier("tab-switcher-archive-all")
      }
    }
  }

  private func unpin(_ site: PinnedSite) {
    Haptics.tick()
    browser.unpin(site)
  }
}

/// VoiceOver can't drag a folder, so each one offers moving up or down past its neighbour.
private struct FolderOrderActions: ViewModifier {
  @EnvironmentObject private var strings: Strings
  let folders: [BrowserFolder]
  let index: Int
  @ObservedObject var browser: BrowserModel

  func body(content: Content) -> some View {
    let id = folders[index].id
    let up = index > 0 ? folders[index - 1].id : nil
    let down = index < folders.count - 1 ? folders[index + 1].id : nil
    return content
      .accessibilityAction(named: Text(verbatim: strings.t("tabs.folderUp"))) {
        if let up { browser.moveFolder(id, beside: up, after: false) }
      }
      .accessibilityAction(named: Text(verbatim: strings.t("tabs.folderDown"))) {
        if let down { browser.moveFolder(id, beside: down, after: true) }
      }
  }
}

/// What the Pinned section's name field is for.
private enum FolderNaming: Equatable {
  case new
  case rename(String)
}

/// Where each pinned row, folder and the heading sit in the Pinned section.
private struct PinFrames: PreferenceKey {
  static let defaultValue: [String: CGRect] = [:]
  static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
    value.merge(nextValue()) { $1 }
  }
}

/// A folder's name typed where the folder sits: Done or tapping away keeps it; left empty, nothing changes. Answers
/// nil for nothing typed.
struct FolderNameField: View {
  let name: String
  let placeholder: String
  let onDone: (String?) -> Void
  @State private var text = ""
  @State private var done = false
  @FocusState private var focused: Bool

  var body: some View {
    HStack(spacing: Space.md) {
      BayIconView(.folder, size: IconSize.small, color: BayColor.muted)
      TextField(placeholder, text: $text)
        .focused($focused)
        .submitLabel(.done)
        .onSubmit(finish)
        .accessibilityIdentifier("tab-folder-name")
    }
    .padding(.horizontal, Space.sm)
    .frame(minHeight: 40)
    .background(BayColor.fill, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
    .onAppear {
      text = name
      DispatchQueue.main.async { focused = true }
    }
    .onChange(of: focused) { if !$0 { finish() } }
  }

  private func finish() {
    guard !done else { return }
    done = true
    let trimmed = text.trimmingCharacters(in: .whitespaces)
    onDone(trimmed.isEmpty ? nil : trimmed)
  }
}

/// A tab's card: its picture (or icon, or the wallpaper for a new tab), a close button, and its site below. A flick
/// up closes it into the archive.
private struct TabCard: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @Environment(\.colorScheme) private var scheme
  let tab: BrowserTab
  let index: Int
  let count: Int
  let width: CGFloat
  let height: CGFloat
  let active: Bool
  @ObservedObject var browser: BrowserModel
  @State private var lift: CGFloat = 0
  @State private var held = false
  /// Held and moved: the card follows the finger, to a space in the bar below.
  @State private var carried: CGSize?
  /// Where the card sits on screen, so the page can grow out of it.
  @State private var frame: CGRect = .zero

  var body: some View {
    let title = tab.title.isEmpty ? (tab.url.isEmpty ? strings.t("tabs.newTab") : displayUrl(url: tab.url)) : tab.title
    let site = tab.url.isEmpty ? title : String(displayUrl(url: tab.url).replacingOccurrences(of: "www.", with: "", options: .anchored).split(separator: "/").first ?? "")
    VStack(alignment: .leading, spacing: Space.xs) {
      ZStack(alignment: .topTrailing) {
        Button {
          // Held, the card opened the pin sheet instead.
          if held {
            held = false
          } else {
            browser.pick(tab, frame: frame)
          }
        } label: {
          picture
            .frame(width: width, height: height)
            .background(tab.private ? Color(RGBA(0x17, 0x17, 0x17)) : (scheme == .dark ? Color(RGBA(0x17, 0x17, 0x17)) : .white))
            .clipShape(RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
            .overlay(
              RoundedRectangle(cornerRadius: Radius.tile, style: .continuous)
                .stroke(active ? BayColor.accent : BayColor.hairline, lineWidth: active ? 2.5 : 1 / UIScreen.main.scale))
            .background(GeometryReader { geometry in
              Color.clear
                .onAppear {
                  frame = geometry.frame(in: .global)
                  browser.cardFrames[tab.id] = frame
                }
                .onChange(of: geometry.frame(in: .global)) {
                  frame = $0
                  browser.cardFrames[tab.id] = $0
                }
            })
        }
        .buttonStyle(.plain)
        .simultaneousGesture(hold)
        // A hold whose lift never reached the card (the finger slid off) doesn't eat the next tap.
        .onChange(of: browser.panel) { if $0 == nil { held = false } }
        .scaleEffect(held && carried == nil ? 1.03 : 1)
        .shadow(color: .black.opacity(carried == nil ? 0.12 : 0.3), radius: carried == nil ? 10 : 18, y: carried == nil ? 4 : 10)
        .accessibilityLabel(Text(verbatim: strings.t("tabs.openLabel", ["title": title])))
        .accessibilityValue(
          Text(verbatim: strings.t(tab.private ? "tabs.privatePosition" : "tabs.position", ["index": "\(index + 1)", "count": "\(count)"])))
        .accessibilityAddTraits(active ? .isSelected : [])
        .modifier(MoveToSpaceActions(tab: tab, browser: browser))
        .accessibilityIdentifier("tab-card-\(index)")
        // While the page shrinks into this card, or grows out of it, the page is the card.
        .opacity(browser.opening?.id == tab.id || browser.zoom?.tab.id == tab.id ? 0 : 1)
        Button(action: close) {
          BayIconView(.close, size: 12, color: .white)
            .frame(width: 22, height: 22)
            .background(Color.black.opacity(0.45), in: Circle())
            // The badge stays small on the card; the finger gets the room round it.
            .frame(width: 34, height: 34)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: strings.t("tabs.closeLabel", ["title": title])))
        .accessibilityIdentifier("tab-close-\(index)")
        // The card says it's private already; the badge shows it.
        if tab.private {
          BayIconView(.private, size: 12, color: Color(RGBA(0xF4, 0xF4, 0xF5)))
            .frame(width: 22, height: 22)
            .background(Color(RGBA(0x17, 0x17, 0x17)), in: Circle())
            .padding(6)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .allowsHitTesting(false)
            .accessibilityIdentifier("tab-private-\(index)")
        }
      }
      HStack(spacing: 4) {
        if !tab.url.isEmpty { SiteIcon(url: tab.url, size: 14) }
        BayText(site, variant: .caption, tone: .muted).lineLimit(1)
      }
      .accessibilityHidden(true)
    }
    // Shrunk where it sits, then moved, so the card stays under the finger.
    .scaleEffect(carried == nil ? 1 : (browser.cardDropSpace == nil ? 0.9 : 0.6), anchor: .center)
    .offset(carried ?? CGSize(width: 0, height: lift))
    .zIndex(carried == nil ? 0 : 1)
    .opacity(1 - Double(min(1, -lift / 240)))
    .simultaneousGesture(
      DragGesture(minimumDistance: 16)
        .onChanged { value in
          guard !held, abs(value.translation.height) > abs(value.translation.width) else { return }
          lift = min(0, value.translation.height)
        }
        .onEnded { value in
          guard !held else { return }
          let velocity = value.predictedEndTranslation.height - value.translation.height
          // Thrown away when dragged far enough up, or flicked up.
          if value.translation.height < -120 || (value.translation.height < -30 && velocity < -200) {
            withAnimation(.easeOut(duration: 0.18)) { lift = -height }
            close()
          } else {
            withAnimation(Motion.settle.animation) { lift = 0 }
          }
        })
  }

  @ViewBuilder private var picture: some View {
    if let snapshot = tab.snapshot {
      FileImage(uri: snapshot, points: max(width, height)) { image in
        image.resizable().scaledToFill().frame(width: width, height: height, alignment: .top).clipped()
      } placeholder: { failed in
        if failed, !tab.url.isEmpty { SiteIcon(url: tab.url, size: 32) } else { Color.clear }
      }
    } else if !tab.url.isEmpty {
      SiteIcon(url: tab.url, size: 32)
    } else {
      // A new tab shows the start page, so its card shows the wallpaper.
      ZStack(alignment: .bottom) {
        if !tab.private { WallpaperView(id: app.preferences.wallpaper) }
        BayIconView(.add, size: IconSize.small, color: BayColor.muted).padding(.bottom, Space.md)
      }
    }
  }

  private func close() {
    Haptics.tick()
    browser.archive(tab.id)
  }

  /// Holding the card: let go where it was for its sheet (pinning it, its space); moved, it follows the finger, and
  /// let go over a space in the bar below, the tab moves there.
  private var hold: some Gesture {
    LongPressGesture(minimumDuration: 0.45)
      .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .global))
      .onChanged { value in
        guard case .second(true, let drag) = value else { return }
        if !held {
          held = true
          Haptics.tick()
        }
        guard let drag else { return }
        if carried == nil, hypot(drag.translation.width, drag.translation.height) < 10 { return }
        carried = drag.translation
        browser.cardDragged(to: drag.location)
      }
      .onEnded { value in
        guard case .second(true, _) = value else { return }
        let target = browser.cardDropSpace
        browser.cardDragged(to: nil)
        if carried == nil {
          browser.showPinMenu(tab)
          return
        }
        if let target {
          browser.moveTab(tab, to: target)
        }
        withAnimation(Motion.settle.animation) { carried = nil }
        // The lift's tap, if it reached the card, is the hold's.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { held = false }
      }
  }
}

/// VoiceOver can't carry a card to a space, so each card offers the other spaces to move its tab to.
private struct MoveToSpaceActions: ViewModifier {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  let tab: BrowserTab
  @ObservedObject var browser: BrowserModel

  func body(content: Content) -> some View {
    app.spaces.filter { $0.id != tab.spaceId }.reduce(AnyView(content)) { view, space in
      AnyView(view.accessibilityAction(named: Text(verbatim: strings.t("tabs.moveToSpace", ["name": spaceName(space, strings)]))) {
        browser.moveTab(tab, to: space.id)
      })
    }
  }
}

/// A space beside the one showing while a swipe pulls it in: its name and its tabs' pictures, drawn only.
private struct SpacePreview: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @Environment(\.colorScheme) private var scheme
  let space: BrowserSpace
  let cardWidth: CGFloat
  let cardHeight: CGFloat
  let gap: CGFloat
  let columns: Int

  var body: some View {
    let name = spaceName(space, strings)
    // Private tabs stay out of sight, as they do in their own space's page until it shows.
    let tabs = app.allTabs.filter { $0.spaceId == space.id && !$0.private }.prefix(8)
    VStack(alignment: .leading, spacing: Space.lg) {
      HStack(spacing: Space.sm) {
        SpaceGlyph(space: space, name: name, size: 30)
        BayText(name, variant: .title).lineLimit(1)
        Spacer(minLength: 0)
      }
      .frame(minHeight: 44)
      LazyVGrid(columns: Array(repeating: GridItem(.fixed(cardWidth), spacing: gap), count: columns), alignment: .leading, spacing: Space.lg) {
        ForEach(Array(tabs), id: \.id) { tab in
          picture(tab)
            .frame(width: cardWidth, height: cardHeight)
            .background(scheme == .dark ? Color(RGBA(0x17, 0x17, 0x17)) : .white)
            .clipShape(RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.tile, style: .continuous).stroke(BayColor.hairline, lineWidth: 1 / UIScreen.main.scale))
            .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
        }
      }
    }
    .padding(.horizontal, Space.gutter)
    .padding(.top, Space.sm)
    .frame(maxWidth: .infinity, alignment: .leading)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  @ViewBuilder private func picture(_ tab: BrowserTab) -> some View {
    if let snapshot = tab.snapshot {
      FileImage(uri: snapshot, points: max(cardWidth, cardHeight)) { image in
        image.resizable().scaledToFill().frame(width: cardWidth, height: cardHeight, alignment: .top).clipped()
      } placeholder: { failed in
        if failed, !tab.url.isEmpty { SiteIcon(url: tab.url, size: 32) } else { Color.clear }
      }
    } else if !tab.url.isEmpty {
      SiteIcon(url: tab.url, size: 32)
    } else {
      WallpaperView(id: app.preferences.wallpaper)
    }
  }
}
