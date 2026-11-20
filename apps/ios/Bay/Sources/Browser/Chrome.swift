import BayCore
import BayDesign
import BayEngine
import SwiftUI

/// The browser's pages: the loaded tabs' views in one UIKit container, the one showing on top. The views are kept
/// across SwiftUI updates, so a page isn't reloaded when the screen around it changes. A page view is made only once
/// the container is in a window: WebKit restores a saved tab state into a blank page when it is set off screen.
struct PagesHost: UIViewRepresentable {
  @ObservedObject var browser: BrowserModel
  /// False under the tab switcher: no page is active, and VoiceOver skips them all.
  var shown = true
  /// How much of a page's bottom the floating bar covers, in points: WebKit keeps what a page pins to its bottom above
  /// it, while content still scrolls under the bar. 0 while the bar is away.
  var coveredBottom: CGFloat = 0

  final class Container: UIView {
    var sync: (() -> Void)?

    override func didMoveToWindow() {
      super.didMoveToWindow()
      if window != nil { sync?() }
    }
  }

  func makeUIView(context: Context) -> Container {
    let container = Container()
    container.clipsToBounds = true
    return container
  }

  func updateUIView(_ container: Container, context: Context) {
    let browser = browser
    let shown = shown
    let covered = coveredBottom
    // SwiftUI's accessibilityHidden stops at the representable; the page views are UIKit's. Hidden, the pages stay in
    // the window and keep playing; the switcher covers them anyway.
    container.isHidden = !shown
    // WebKit's page content answers VoiceOver from its own process, so hiding the views alone can leave it reachable.
    container.accessibilityElementsHidden = !shown
    container.sync = { [weak container] in
      guard let container else { return }
      MainActor.assumeIsolated { Self.sync(container, browser, shown: shown, covered: covered) }
    }
    container.sync?()
  }

  @MainActor private static func sync(_ container: Container, _ browser: BrowserModel, shown: Bool, covered: CGFloat) {
    guard container.window != nil else { return }
    let tabs = browser.app.tabs
    for (index, id) in browser.mounted.enumerated() {
      guard let tab = tabs.first(where: { $0.id == id }) else { continue }
      let view = browser.view(for: tab)
      if view.superview !== container {
        view.frame = container.bounds
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(view)
      }
      let showing = index == 0 && shown
      view.obscuredBottom = covered
      view.isHidden = !showing
      view.accessibilityElementsHidden = !showing
      view.isActive = showing
      if showing { container.bringSubviewToFront(view) }
    }
  }
}

/// The site's saved icon on a tile, else a monogram on a tint picked from its name. Icons are local files, so this
/// never loads anything from the network. It always sits beside the site's name, so VoiceOver skips it.
struct SiteIcon: View {
  @EnvironmentObject private var app: AppModel
  @Environment(\.colorScheme) private var scheme
  let url: String
  var size: CGFloat = 28
  /// Already on a tile of its own (a pin): the icon or the letter alone.
  var bare = false

  private static let tints: [RGBA] = [
    RGBA(0xDC, 0xE8, 0xF5), RGBA(0xF3, 0xE2, 0xD6), RGBA(0xE3, 0xEE, 0xDF), RGBA(0xEC, 0xE1, 0xF2), RGBA(0xF5, 0xE9, 0xC9),
    RGBA(0xDD, 0xEE, 0xEE),
  ]

  var body: some View {
    let host = hostOf(url: url)
    Group {
      if let file = app.favicons[host].flatMap(URL.init(string:)), let image = UIImage(contentsOfFile: file.path) {
        if bare {
          Image(uiImage: image).resizable().scaledToFit().frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.14, style: .continuous))
        } else {
          Image(uiImage: image).resizable().scaledToFit().frame(width: size * 0.72, height: size * 0.72)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.14, style: .continuous))
            .frame(width: size, height: size)
            .background(scheme == .dark ? Color(RGBA(0x2C, 0x2C, 0x2E)) : .white, in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
        }
      } else {
        monogram(host)
      }
    }
    .accessibilityHidden(true)
  }

  @ViewBuilder private func monogram(_ host: String) -> some View {
    let letter = host.first(where: { $0.isLetter || $0.isNumber }).map { String($0).uppercased() } ?? "•"
    if bare {
      Text(verbatim: letter).font(.system(size: size * 0.82, weight: .semibold)).foregroundColor(BayColor.foreground)
        .frame(width: size, height: size)
    } else {
      let hash = host.unicodeScalars.reduce(Int32(0)) { ($0 &* 31) &+ Int32(truncatingIfNeeded: $1.value) }
      Text(verbatim: letter).font(.system(size: size * 0.48, weight: .semibold)).foregroundColor(Color(RGBA(0x26, 0x31, 0x3D)))
        .frame(width: size, height: size)
        .background(Color(Self.tints[Int(hash.magnitude) % Self.tints.count]), in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
    }
  }
}

/// Bay's start-page wallpaper: a wash under a fine dot grid, the theme's background for Plain.
struct WallpaperView: View {
  let id: WallpaperId
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    Group {
      if let palette = Wallpapers.palette("\(id)", dark: scheme == .dark) {
        ZStack {
          LinearGradient(
            stops: [.init(color: palette.top, location: 0), .init(color: palette.middle, location: 0.55), .init(color: palette.bottom, location: 1)],
            startPoint: .top, endPoint: .bottom)
          Canvas { context, size in
            let step: CGFloat = 14
            var y = step / 2
            while y < size.height {
              var x = step / 2
              while x < size.width {
                context.fill(Path(ellipseIn: CGRect(x: x - 0.9, y: y - 0.9, width: 1.8, height: 1.8)), with: .color(palette.dot.opacity(palette.dotOpacity)))
                x += step
              }
              y += step
            }
          }
        }
      } else {
        BayColor.background
      }
    }
    .ignoresSafeArea()
    .accessibilityHidden(true)
  }
}

/// The floating bar: archive, search and settings over the start page; tabs, the site and more over a page.
struct BrowserBar: View {
  @EnvironmentObject private var strings: Strings
  @ObservedObject var browser: BrowserModel
  let onSettings: () -> Void
  var onChecks: () -> Void = {}
  @State private var swipe: CGFloat = 0
  /// When a hold on Tabs last let go, so the tap the lift also makes doesn't open the tab view.
  @State private var holdEnded = Date.distantPast
  /// Holding Tabs: the column of spaces above the bar, and the one under the finger.
  @State private var sliding = false
  @State private var slideTarget: SlideTarget?
  @State private var tabsFrame: CGRect = .zero

  var body: some View {
    let app = browser.app
    HStack(spacing: Space.md) {
      if browser.overlay == .tabs {
        GlassIconButton(.archive, label: strings.t("bar.archive")) { browser.panel = .archive }
          .accessibilityIdentifier("bar-archive")
        SpacesCapsule(browser: browser)
        GlassIconButton(.add, label: strings.t("bar.newTab")) { browser.search(inNewTab: true) }
          .accessibilityIdentifier("bar-search")
      } else if browser.hasPage {
        tabsButton
        capsule
        GlassIconButton(.more, label: strings.t("bar.more")) {
          browser.app.dispatch(.tipSeen(id: .blocking))
          browser.panel = .page
        }
        .accessibilityIdentifier("bar-more")
        // The ring round the button the blocking tip means.
        .overlay {
          if browser.tip == .blocking {
            Circle().stroke(BayColor.accent, lineWidth: 2.5).padding(-4).allowsHitTesting(false)
          }
        }
      } else {
        GlassIconButton(.archive, label: strings.t("bar.archive")) { browser.panel = .archive }
          .accessibilityIdentifier("bar-archive")
        capsule
        GlassIconButton(.settings, label: strings.t("bar.settings"), action: onSettings)
          .simultaneousGesture(LongPressGesture(minimumDuration: 0.8).onEnded { _ in onChecks() })
          .accessibilityIdentifier("bar-settings")
      }
    }
    // Above the buttons' own taps: a tap never travels the drag's 16 points, so taps still reach them. Off while a held
    // Tabs slides across the spaces.
    .highPriorityGesture(browser.hasPage && browser.overlay == .none && !sliding ? tabSwipe : nil)
  }

  /// Tabs, with the open tabs' count. Holding it brings the column of spaces, the one showing on a soft grey circle: slide
  /// to one and lift to switch, or to + for a new one. Lifting without sliding puts it away.
  private var tabsButton: some View {
    let app = browser.app
    let count = app.tabs.count
    let spaced = app.spaces.count > 1
    let space = browser.activeSpace
    let tabsLabel = count > 1 ? strings.t("bar.tabsOpen", ["count": "\(count)"]) : strings.t("bar.tabs")
    let label = spaced && space != nil ? strings.t("bar.inSpace", ["label": tabsLabel, "space": spaceName(space!, strings)]) : tabsLabel
    return GlassIconButton(.tabs, label: label) {
      // A hold's lift comes as a tap too, before or just after the hold ends.
      guard !sliding, Date().timeIntervalSince(holdEnded) > 0.4 else { return }
      browser.showTabs()
    }
    .simultaneousGesture(spaceSlide)
    .overlay(alignment: .topTrailing) { TabCount(count: count) }
    // The spaces stand in a column above the button while it's held, the nearest first.
    .overlay(alignment: .bottom) {
      if sliding {
        SpaceSlideColumn(spaces: app.spaces, current: app.activeSpaceId, target: slideTarget)
          .fixedSize()
          .alignmentGuide(.bottom) { $0[.bottom] + SpaceSlideColumn.gap + tabsFrame.height }
          .transition(.scale(scale: 0.8, anchor: .bottom).combined(with: .opacity))
      }
    }
    .animation(Motion.settle.animation, value: sliding)
    // The button's place on screen: the column stands on it, so the cell under the finger is worked out from it.
    .background(GeometryReader { proxy in
      Color.clear
        .onAppear { tabsFrame = proxy.frame(in: .global) }
        .onChange(of: proxy.frame(in: .global)) { tabsFrame = $0 }
    })
    .modifier(SpaceActions(browser: browser))
    .accessibilityIdentifier("bar-tabs")
  }

  /// Hold Tabs, then slide: the space under the finger grows and ticks; lifting switches to it. Lifting where it
  /// started, or well away from the column, lets go of nothing.
  private var spaceSlide: some Gesture {
    LongPressGesture(minimumDuration: 0.35)
      .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .global))
      .onChanged { value in
        guard case .second(true, let drag) = value else { return }
        if !sliding {
          sliding = true
          Haptics.tick()
        }
        guard let drag else { return }
        let moved = hypot(drag.translation.width, drag.translation.height) > 12
        let next = moved ? SpaceSlideColumn.target(at: drag.location, above: tabsFrame, count: browser.app.spaces.count) : nil
        if next != slideTarget {
          slideTarget = next
          if next != nil { UISelectionFeedbackGenerator().selectionChanged() }
        }
      }
      .onEnded { value in
        let target = slideTarget
        sliding = false
        slideTarget = nil
        guard case .second(true, _) = value else { return }
        holdEnded = Date()
        switch target {
        case .space(let index):
          browser.switchSpace(browser.app.spaces[index].id)
        case .add:
          browser.newSpace()
        case nil:
          break
        }
      }
  }

  /// Dragging the bar sideways goes to the tab before (right) or after (left), as Arc Search's bar does.
  private var tabSwipe: some Gesture {
    DragGesture(minimumDistance: 16)
      .onChanged { value in
        guard abs(value.translation.width) > abs(value.translation.height) else { return }
        let step = value.translation.width < 0 ? 1 : -1
        let open = browser.app.tabs.indices.contains((browser.app.tabs.firstIndex { $0.id == browser.app.activeTabId } ?? 0) + step)
        swipe = value.translation.width * (open ? 0.4 : 0.12)
      }
      .onEnded { value in
        let distance = value.translation.width
        let flick = value.predictedEndTranslation.width - distance
        withAnimation(Motion.settle.animation) { swipe = 0 }
        // Up opens the tab switcher: far enough, or flicked up.
        let up = -value.translation.height
        if up > abs(distance) {
          if up > 110 || (up > 20 && -value.predictedEndTranslation.height > 260) {
            Haptics.press()
            browser.app.dispatch(.tipSeen(id: .bar))
            browser.showTabs()
          }
          return
        }
        guard abs(distance) > 64 || abs(flick) > 120 else { return }
        Haptics.press()
        browser.swipeTabs(distance < 0 ? 1 : -1)
      }
  }

  private var capsule: some View {
    let site = browser.hasPage ? hostOf(url: browser.activeTab?.url ?? "").replacingOccurrences(of: "www.", with: "", options: .anchored) : ""
    let insecure = browser.activeTab?.url.hasPrefix("http:") ?? false
    let label =
      site.isEmpty
      ? strings.t("bar.search") : strings.t(insecure ? "bar.searchOrEnterInsecure" : "bar.searchOrEnter", ["site": site])
    return Button {
      browser.search(inNewTab: false)
    } label: {
      // Just the magnifying glass: the page's address is at the top of the page menu. A page that isn't sent encrypted
      // says so with a mark beside it.
      HStack(spacing: Space.xs) {
        if insecure, !site.isEmpty {
          Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 13)).foregroundColor(.red)
        }
        Image(systemName: "magnifyingglass").font(.system(size: 17, weight: .medium))
      }
      .foregroundColor(BayColor.foreground)
      .frame(width: 92, height: 20)
      .padding(.vertical, 14)
      .padding(.horizontal, Space.lg)
      .bayCapsule()
      .overlay(alignment: .bottom) { LoadProgress(state: browser.hasPage ? browser.activeNavigation : .empty) }
    }
    .buttonStyle(.pressFeedback)
    .offset(x: swipe)
    .opacity(1 - min(abs(swipe) / 110, 0.6))
    .accessibilityLabel(Text(verbatim: label))
    .accessibilityIdentifier("bar-search")
  }
}

/// The tab view's spaces between archive and new tab, in one capsule: each space's emoji or dot, the one showing
/// larger, and a button for a new space. More spaces than fit scroll inside it.
struct SpacesCapsule: View {
  @EnvironmentObject private var strings: Strings
  @ObservedObject var browser: BrowserModel
  /// The space's name over the capsule while a held finger slides across the spaces.
  @State private var scrubLabel: String?
  @State private var scrubbed: Int?
  @State private var width: CGFloat = 0

  /// Hold the spaces, then slide: the space under the finger shows, with a tick as each one comes.
  private var scrub: some Gesture {
    LongPressGesture(minimumDuration: 0.22)
      .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .local))
      .onChanged { value in
        guard case .second(true, let drag) = value, let drag else { return }
        let spaces = browser.app.spaces
        guard spaces.count > 1, width > 0 else { return }
        let index = min(spaces.count - 1, max(0, Int((drag.location.x / width) * CGFloat(spaces.count))))
        guard index != scrubbed else { return }
        scrubbed = index
        UISelectionFeedbackGenerator().selectionChanged()
        scrubLabel = spaceName(spaces[index], strings)
        browser.selectSpace(spaces[index].id)
      }
      .onEnded { _ in
        scrubbed = nil
        scrubLabel = nil
      }
  }

  var body: some View {
    let app = browser.app
    HStack(spacing: 2) {
      ScrollViewReader { reader in
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 2) {
            ForEach(app.spaces, id: \.id) { space in
              let active = space.id == app.activeSpaceId
              Button {
                Haptics.press()
                browser.selectSpace(space.id)
              } label: {
                Group {
                  if let icon = space.icon {
                    Text(verbatim: icon).font(.system(size: active ? 20 : 15)).opacity(active ? 1 : 0.55)
                  } else {
                    Image(systemName: active ? "app.fill" : "circle.fill").font(.system(size: active ? 18 : 9))
                      .foregroundColor(spaceColor(space.color))
                  }
                }
                .frame(width: 34, height: 34)
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              .id(space.id)
              .accessibilityLabel(Text(verbatim: strings.t("tabs.switchSpace", ["name": spaceName(space, strings)])))
              .accessibilityHint(Text(verbatim: strings.t("tabs.scrubSpacesHint")))
              .accessibilityAddTraits(active ? .isSelected : [])
              .accessibilityIdentifier("bar-space-\(space.id)")
            }
          }
        }
        .frame(maxWidth: CGFloat(app.spaces.count) * 36)
        .background(GeometryReader { geometry in Color.clear.onAppear { width = geometry.size.width }.onChange(of: geometry.size.width) { width = $0 } })
        .simultaneousGesture(scrub)
        .onAppear { reader.scrollTo(app.activeSpaceId, anchor: .center) }
        .onChange(of: app.activeSpaceId) { reader.scrollTo($0, anchor: .center) }
      }
      Button {
        browser.newSpace()
      } label: {
        Image(systemName: "plus").font(.system(size: 15)).foregroundColor(BayColor.muted).frame(width: 34, height: 34)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(Text(verbatim: strings.t("tabsMenu.newSpace")))
      .accessibilityIdentifier("bar-new-space")
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .bayCapsule()
    .scaleEffect(scrubLabel == nil ? 1 : 1.06)
    .animation(.easeOut(duration: 0.14), value: scrubLabel == nil)
    .overlay(alignment: .top) {
      if let scrubLabel {
        BayText(scrubLabel, variant: .footnote, weight: .semibold).lineLimit(1)
          .padding(.horizontal, Space.md)
          .padding(.vertical, Space.xs)
          .baySurface(radius: Radius.control)
          .offset(y: -40)
          .accessibilityIdentifier("bar-space-scrub-label")
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("bar-spaces")
  }
}

/// The number of open tabs on the corner of the Tabs button. The button's label says it, so VoiceOver skips it.
struct TabCount: View {
  let count: Int

  var body: some View {
    if count > 1 {
      Text(verbatim: count > 99 ? "99+" : "\(count)")
        .font(.system(size: 11, weight: .bold))
        .foregroundColor(BayColor.background)
        .padding(.horizontal, 4)
        .frame(minWidth: 20, minHeight: 20)
        .background(BayColor.foreground, in: Capsule())
        .offset(x: 4, y: -4)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .accessibilityIdentifier("tab-count")
    }
  }
}

/// The thin line along the capsule's edge: it fills as the page loads and fades once the page is there.
struct LoadProgress: View {
  let state: NavigationState
  @Environment(\.accessibilityReduceMotion) private var reduced

  var body: some View {
    GeometryReader { geometry in
      Capsule()
        .fill(BayColor.accent)
        .frame(width: max(0, geometry.size.width - 48) * max(state.progress, 0.04), height: 2)
        .padding(.leading, 24)
        .frame(maxHeight: .infinity, alignment: .bottom)
        .padding(.bottom, 2)
    }
    .opacity(state.isLoading ? 1 : 0)
    .animation(reduced ? nil : .easeOut(duration: Motion.settleDuration), value: state.progress)
    .animation(.easeOut(duration: 0.22), value: state.isLoading)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
    .accessibilityIdentifier(state.isLoading ? "page-progress" : "")
  }
}

/// A page that failed to load, in plain words, and a way to try again.
struct PageErrorView: View {
  @EnvironmentObject private var strings: Strings
  let message: String
  let retry: () -> Void

  var body: some View {
    let id = pageErrorId(message: message)
    let known = id != .unknown
    VStack(spacing: Space.md) {
      BayIconView(describePageError(message: message).kind == .offline ? .offline : .error, size: 40, color: BayColor.muted)
      BayText(strings.t("pageError.\(id).title"), variant: .headline).multilineTextAlignment(.center)
      BayText(known ? strings.t("pageError.\(id).detail") : message, variant: .callout, tone: .muted).multilineTextAlignment(.center)
      PillButton(strings.t("pageError.tryAgain"), action: retry).accessibilityIdentifier("page-error-retry")
    }
    .padding(Space.xl)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(BayColor.background)
    .accessibilityIdentifier("page-error")
  }
}

/// VoiceOver can't hold and slide, so Tabs offers each other space as an action, and a new one. iOS 15 has no list of
/// actions; there Tabs opens the tab view, whose spaces are buttons.
private struct SpaceActions: ViewModifier {
  @EnvironmentObject private var strings: Strings
  @ObservedObject var browser: BrowserModel

  func body(content: Content) -> some View {
    if #available(iOS 16, *) {
      content.accessibilityActions {
        ForEach(browser.app.spaces.filter { $0.id != browser.app.activeSpaceId }, id: \.id) { other in
          Button(strings.t("tabs.switchSpace", ["name": spaceName(other, strings)])) { browser.switchSpace(other.id) }
        }
        Button(strings.t("tabsMenu.newSpace")) { browser.newSpace() }
      }
    } else {
      content
    }
  }
}

/// What a held Tabs button's finger is over in the row of spaces.
enum SlideTarget: Equatable {
  case space(Int)
  case add
}

/// The column of spaces above a held Tabs button: each space's glyph in a cell of its own, the nearest space at the
/// bottom, the one under the finger larger with its name over the column, the space showing on a soft circle, and a
/// new space on top.
struct SpaceSlideColumn: View {
  @EnvironmentObject private var strings: Strings
  let spaces: [BrowserSpace]
  let current: String
  let target: SlideTarget?

  static let cell: CGFloat = 52

  private var targetName: String? {
    switch target {
    case .space(let index): return spaces.indices.contains(index) ? spaceName(spaces[index], strings) : nil
    case .add: return strings.t("tabsMenu.newSpace")
    case nil: return nil
    }
  }

  /// An opaque surface with the bar buttons' edge, so the page never shows through the spaces.
  static func solid<S: InsettableShape>(_ shape: S) -> some View {
    shape.fill(BayColor.background).overlay(shape.strokeBorder(BayColor.hairline, lineWidth: 1))
      .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
  }

  /// The space between the Tabs button and the column standing on it.
  static let gap: CGFloat = Space.md

  /// The cell under `point`, in the column standing `gap` above the Tabs button at `button`, counting up from its
  /// bottom; nothing far to either side of it.
  static func target(at point: CGPoint, above button: CGRect, count: Int) -> SlideTarget? {
    guard button.height > 0, point.x > button.midX - cell * 1.5, point.x < button.midX + cell * 2.5 else { return nil }
    let bottom = button.minY - gap
    let index = Int(((bottom - Space.sm - point.y) / cell).rounded(.down))
    if index == count { return .add }
    return (0..<count).contains(index) ? .space(index) : nil
  }

  var body: some View {
    VStack(spacing: Space.xs) {
      // What's under the finger, named over the column.
      if let name = targetName {
        BayText(name, variant: .footnote, weight: .semibold).lineLimit(1).fixedSize()
          .padding(.horizontal, Space.sm)
          .padding(.vertical, Space.xxs)
          .background(Self.solid(Capsule()))
      }
      VStack(spacing: 0) {
        BayIconView(.add, size: target == .add ? IconSize.control : IconSize.row, color: target == .add ? BayColor.foreground : BayColor.muted)
          .frame(width: Self.cell, height: Self.cell)
          .background {
            if target == .add { Circle().fill(BayColor.fill).frame(width: 44, height: 44) }
          }
        ForEach(Array(spaces.enumerated().reversed()), id: \.element.id) { index, space in
          let hovered = target == .space(index)
          SpaceGlyph(space: space, name: spaceName(space, strings), size: hovered ? 30 : 24)
            .frame(width: Self.cell, height: Self.cell)
            // The space showing sits on a soft circle; the one under the finger on a wash of its own colour.
            .background {
              if hovered {
                Circle().fill(spaceColor(space.color).opacity(0.22)).frame(width: 44, height: 44)
              } else if space.id == current {
                Circle().fill(BayColor.fill).frame(width: 40, height: 40)
              }
            }
        }
      }
      .padding(.vertical, Space.sm)
      .background(Self.solid(RoundedRectangle(cornerRadius: Self.cell / 2, style: .continuous)))
    }
    .animation(.easeOut(duration: 0.12), value: target)
    .accessibilityHidden(true)
    .accessibilityIdentifier("space-slide-row")
  }
}
