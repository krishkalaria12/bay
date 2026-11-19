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
    let hasPinned = !rows.isEmpty || !app.folders.isEmpty
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
          .onLongPressGesture { unpin(pin) }
          .accessibilityElement()
          .accessibilityAddTraits(active ? [.isButton, .isSelected] : .isButton)
          .accessibilityLabel(Text(verbatim: pin.title.isEmpty ? displayUrl(url: pin.url) : pin.title))
          .accessibilityHint(Text(verbatim: strings.t("pin.unpinHint")))
          .accessibilityIdentifier("tab-essential-\(index)")
      }
    }
  }

  private func pinnedRows(_ rows: [PinnedSite]) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      BayText(strings.t("tabs.pinned"), variant: .footnote, weight: .medium, tone: .overWallpaper).padding(.bottom, Space.xs)
      ForEach(rows.filter { $0.folderId == nil }, id: \.id) { row in pinRow(row, indent: false) }
      ForEach(app.folders, id: \.id) { folder in
        PinFolder(folder: folder, rows: rows.filter { $0.folderId == folder.id }, activeUrl: browser.activeTab?.url) { row in
          pinRow(row, indent: true)
        }
      }
    }
  }

  private func pinRow(_ row: PinnedSite, indent: Bool) -> some View {
    let activeUrl = browser.activeTab?.url
    return Group {
        let active = row.url == activeUrl
        Button {
          browser.openPin(row)
        } label: {
          HStack(spacing: Space.md) {
            SiteIcon(url: row.url, size: 20)
            BayText(row.title.isEmpty ? displayUrl(url: row.url) : row.title, variant: .callout, weight: active ? .semibold : .regular)
              .lineLimit(1)
            Spacer(minLength: 0)
          }
          .padding(.leading, indent ? Space.xl + Space.sm : Space.sm)
          .padding(.trailing, Space.sm)
          .frame(minHeight: 40)
          .background(active ? BayColor.fill : .clear, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        }
        .buttonStyle(.pressFeedback)
        .simultaneousGesture(LongPressGesture().onEnded { _ in unpin(row) })
        .accessibilityHint(Text(verbatim: strings.t("pin.unpinHint")))
        .accessibilityAddTraits(active ? .isSelected : [])
        .accessibilityIdentifier("tab-pinned-\(row.id)")
    }
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

/// A pinned folder: a row that opens to show the pinned rows in it, as the desktop's Pinned folders do. A folder holding
/// the page on screen starts open.
private struct PinFolder<Row: View>: View {
  let folder: BrowserFolder
  let rows: [PinnedSite]
  let activeUrl: String?
  let row: (PinnedSite) -> Row
  @State private var open: Bool

  init(folder: BrowserFolder, rows: [PinnedSite], activeUrl: String?, @ViewBuilder row: @escaping (PinnedSite) -> Row) {
    self.folder = folder
    self.rows = rows
    self.activeUrl = activeUrl
    self.row = row
    _open = State(initialValue: rows.contains { $0.url == activeUrl })
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Button {
        withAnimation(.easeOut(duration: Motion.tap)) { open.toggle() }
      } label: {
        HStack(spacing: Space.md) {
          BayIconView(.folder, size: IconSize.small)
          BayText(folder.name, variant: .callout).lineLimit(1)
          Spacer(minLength: 0)
          BayText(rows.isEmpty ? "" : "\(rows.count)", variant: .footnote, tone: .overWallpaper)
          BayIconView(.chevron, size: IconSize.inline, color: BayColor.muted).rotationEffect(.degrees(open ? 90 : 0))
        }
        .padding(.horizontal, Space.sm)
        .frame(minHeight: 40)
        .contentShape(Rectangle())
      }
      .buttonStyle(.pressFeedback)
      .accessibilityLabel(Text(verbatim: folder.name))
      .accessibilityValue(Text(verbatim: open ? "expanded" : "collapsed"))
      .accessibilityIdentifier("tab-folder-\(folder.id)")
      if open { ForEach(rows, id: \.id) { row($0) } }
    }
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
                .onAppear { frame = geometry.frame(in: .global) }
                .onChange(of: geometry.frame(in: .global)) { frame = $0 }
            })
        }
        .buttonStyle(.plain)
        .simultaneousGesture(
          LongPressGesture().onEnded { _ in
            held = true
            browser.showPinMenu(tab)
          })
        // A hold whose lift never reached the card (the finger slid off) doesn't eat the next tap.
        .onChange(of: browser.panel) { if $0 == nil { held = false } }
        .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
        .accessibilityLabel(Text(verbatim: strings.t("tabs.openLabel", ["title": title])))
        .accessibilityValue(
          Text(verbatim: strings.t(tab.private ? "tabs.privatePosition" : "tabs.position", ["index": "\(index + 1)", "count": "\(count)"])))
        .accessibilityAddTraits(active ? .isSelected : [])
        .accessibilityIdentifier("tab-card-\(index)")
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
    .offset(y: lift)
    .opacity(1 - Double(min(1, -lift / 240)))
    .simultaneousGesture(
      DragGesture(minimumDistance: 16)
        .onChanged { value in
          guard abs(value.translation.height) > abs(value.translation.width) else { return }
          lift = min(0, value.translation.height)
        }
        .onEnded { value in
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
    if let snapshot = tab.snapshot.flatMap(URL.init(string:)), let image = UIImage(contentsOfFile: snapshot.path) {
      Image(uiImage: image).resizable().scaledToFill().frame(width: width, height: height, alignment: .top).clipped()
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
    if let snapshot = tab.snapshot.flatMap(URL.init(string:)), let image = UIImage(contentsOfFile: snapshot.path) {
      Image(uiImage: image).resizable().scaledToFill().frame(width: cardWidth, height: cardHeight, alignment: .top).clipped()
    } else if !tab.url.isEmpty {
      SiteIcon(url: tab.url, size: 32)
    } else {
      WallpaperView(id: app.preferences.wallpaper)
    }
  }
}
