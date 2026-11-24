import BayCore
import BayDesign
import BayEngine
import SwiftUI

/// Bay's one screen: the page showing (or the start page), the floating bar, and what opens over them.
struct BrowserScreen: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @Environment(\.colorScheme) private var scheme
  @ObservedObject var browser: BrowserModel
  let onSettings: () -> Void
  /// The stand-in check screens, for testing.
  var onChecks: () -> Void = {}

  private static let barHeight: CGFloat = 52
  /// The screen's bottom safe area (the home indicator), which the bar sits above.
  @State private var safeBottom: CGFloat = 0
  /// The switcher has come up: from a page it fades in behind the page shrinking into its card.
  @State private var switcherRevealed = true

  /// How small the switcher goes as a card grows back into its page.
  private static let switcherFrom: CGFloat = 0.94

  /// What the floating bar covers at the bottom of a page: from the screen's edge up past its top, with a little room.
  /// It stays put while the bar scrolls away: a change lays the page out again, and mid-scroll that shook the page.
  /// Only a fullscreen site, which has no bar, gets the whole screen.
  private var coveredBottom: CGFloat {
    browser.fullscreen ? 0 : max(safeBottom, Space.md) + Space.xs + Self.barHeight + Space.sm
  }

  var body: some View {
    ZStack(alignment: .bottom) {
      WallpaperView(id: app.preferences.wallpaper)
      // The pages stay in place under the switcher, so a page isn't torn down and reloaded on the way back.
      if browser.hasPage || !browser.mounted.isEmpty {
        let shown = browser.hasPage && browser.overlay != .tabs && !browser.covered
        PagesHost(browser: browser, shown: shown, coveredBottom: coveredBottom)
          .ignoresSafeArea(edges: .bottom)
          .offset(x: browser.spaceSlide + browser.swipeOffset)
          .opacity(shown ? 1 : 0)
          .allowsHitTesting(shown)
        if shown { swipePictures }
      }
      if let tab = browser.swipeCover, browser.overlay == .none {
        TabPicture(tab: tab, color: browser.pageColors[tab.id]).opacity(browser.swipeCoverShown ? 1 : 0)
          .offset(x: browser.spaceSlide)
      }
      if browser.overlay == .tabs {
        // In from a page, the page shrinks into its card as the switcher comes up behind it; back to a page, the card
        // grows into it as the switcher falls away.
        let shownSwitcher = switcherRevealed && browser.zoom == nil
        WallpaperView(id: app.preferences.wallpaper)
        TabSwitcher(browser: browser, onSettings: onSettings)
          .opacity(shownSwitcher ? 1 : 0)
          // Only falling away: coming up it keeps its size, so the cards are where the page reads them to land.
          .scaleEffect(browser.zoom == nil ? 1 : Self.switcherFrom)
          .animation(Motion.open.animation, value: browser.zoom == nil)
          .onAppear(perform: revealSwitcher)
        if let tab = browser.opening {
          TabMorph(
            tab: tab, color: browser.pageColors[tab.id], wallpaper: app.preferences.wallpaper, card: { [browser] in browser.cardFrames[tab.id] },
            shrinking: true, onDone: browser.openingDone)
        }
      } else if browser.hasPage {
        if let failure = browser.failure, failure.tabId == app.activeTabId {
          PageErrorView(message: failure.message, retry: browser.retry)
        }
        statusStrip
      } else if browser.overlay == .none {
        startScreen.offset(x: browser.spaceSlide)
      }
      if let zoom = browser.zoom {
        TabMorph(
          tab: zoom.tab, color: browser.pageColors[zoom.tab.id], wallpaper: app.preferences.wallpaper, card: { zoom.frame }, shrinking: false,
          onDone: browser.zoomFinished)
      }
      if browser.locked, browser.activeTab?.private == true, browser.overlay == .none {
        PrivateLockView(onUnlock: browser.unlock)
      }
      if browser.overlay != .search {
        VStack(spacing: Space.md) {
          if let player = browser.player {
            MiniPlayer(browser: browser, tab: player.tab, media: player.media)
          }
          if let item = browser.downloadToast {
            DownloadToast(browser: browser, item: item)
          }
          if let toast = browser.toast {
            ToastView(toast: toast, onDone: browser.dismissToast).id(toast.id)
          }
          if browser.tip == .bar {
            TipCard(title: strings.t("tip.bar.title"), body_: strings.t("tip.bar.body")) { app.dispatch(.tipSeen(id: .bar)) }
          } else if browser.tip == .blocking {
            TipCard(title: strings.t("tip.blocking.title"), body_: strings.t("tip.blocking.body")) { app.dispatch(.tipSeen(id: .blocking)) }
          }
          // The picker's card sits over the bar, which stays: Settings and the page menu are still in reach.
          if let mode = browser.picking, browser.hasPage {
            PickerCard(browser: browser, mode: mode)
          }
          if browser.find != nil, browser.hasPage {
            FindBar(browser: browser)
          } else {
            BrowserBar(browser: browser, onSettings: onSettings, onChecks: onChecks)
          }
        }
        .padding(.horizontal, Space.edge)
        .padding(.bottom, Space.xs)
        // Over a page the bar (and what stands on it) is light or dark as the page is along its foot, where it runs on
        // under the bar, as on Android.
        .environment(\.colorScheme, barScheme)
        // Out of sight on a fullscreen site, with the toast and the player. Over a page scrolling down the bar shrinks
        // instead (BrowserBar).
        .offset(y: browser.fullscreen ? 140 : 0)
        .animation(.easeOut(duration: 0.2), value: browser.fullscreen)
        .animation(.easeOut(duration: 0.2), value: browser.toast?.id)
      }
      if browser.fullscreen {
        // The screen's bottom edge on a fullscreen site: a tap brings the bar back for a moment.
        Color.clear
          // The bar's own height at the screen's foot; the bottom inset grows with the keyboard, so it isn't used.
          .frame(height: Self.barHeight)
          .contentShape(Rectangle())
          .onTapGesture(perform: browser.peekBar)
          .ignoresSafeArea(edges: .bottom)
          .accessibilityElement()
          .accessibilityAddTraits(.isButton)
          .accessibilityLabel(Text(verbatim: strings.t("site.fullscreen")))
          .accessibilityHint(Text(verbatim: strings.t("site.fullscreen.note")))
          .accessibilityIdentifier("fullscreen-edge")
      }
      if browser.overlay == .search {
        SearchCard(
          browser: browser, initialText: browser.searchInNewTab ? "" : (browser.activeTab?.url ?? ""),
          // A new tab starts as a normal one unless asked for private; editing a private tab's address stays private.
          privately: browser.searchPrivately || (!browser.searchInNewTab && (browser.activeTab?.private ?? false)),
          page: browser.searchOverPage)
        .environment(\.colorScheme, searchOverDarkPage ? .dark : scheme)
      }
      Group {
        if browser.drawerOpen {
          BookmarksDrawer(browser: browser)
            .transition(.move(edge: .trailing))
        }
      }
      .zIndex(4)
      .animation(Motion.settle.animation, value: browser.drawerOpen)
      VStack {
        if let note = browser.topNote {
          TopPill(note: note, onDone: browser.dismissTopNote).id(note.id).padding(.top, Space.xs)
        }
        Spacer(minLength: 0)
      }
      .animation(Motion.settle.animation, value: browser.topNote?.id)
    }
    .background(
      GeometryReader { proxy in
        Color.clear
          .onAppear { safeBottom = proxy.safeAreaInsets.bottom }
          .onChange(of: proxy.safeAreaInsets.bottom) { safeBottom = $0 }
      }
    )
    .baySheet(isPresented: Binding(get: { browser.panel != nil }, set: { if !$0 { browser.panel = nil } }), maxFraction: 0.62) {
      Group {
        switch browser.panel {
        case .page:
          PageMenu(browser: browser, onSettings: onSettings)
        case .spaceEdit:
          if let space = browser.activeSpace { SpaceEditPanel(browser: browser, space: space) }
        case .history:
          HistoryPanel(browser: browser)
        case .save:
          SavePanel(browser: browser)
        case .downloads:
          DownloadsPanel(browser: browser)
        case .import:
          ImportPanel(browser: browser)
        case .siteSettings:
          SiteSettingsPanel(browser: browser, onSettings: onSettings)
        case .link:
          if let link = browser.link { LinkMenu(browser: browser, link: link) }
        case .pin:
          if let tab = browser.pinTab { PinPanel(browser: browser, tab: tab) }
        case .reader:
          ReaderPanel(browser: browser)
        case .inspect:
          if let element = browser.inspected { InspectPanel(browser: browser, element: element) }
        case .request:
          if let request = browser.pageRequests.first?.request { PageRequestPanel(browser: browser, request: request).id(request.id) }
        case nil:
          EmptyView()
        }
      }
      .environmentObject(strings)
      .environmentObject(app)
    }
    .onChange(of: app.preferences) { _ in browser.preferencesChanged() }
    .onChange(of: browser.tip) { browser.tipShown($0) }
    .onAppear {
      browser.refreshMounted()
    }
    .onChange(of: app.activeTabId) { _ in
      browser.refreshMounted()
      browser.pauseMediaLeft()
    }
    .onChange(of: browser.overlay) { _ in browser.pauseMediaLeft() }
    .statusBarHidden(browser.fullscreen)
    .onChange(of: app.tabs.map(\.url)) { _ in browser.refreshMounted() }
  }

  /// The switcher comes up behind the page shrinking into its card; opened any other way it's simply there.
  private func revealSwitcher() {
    guard browser.opening != nil else {
      switcherRevealed = true
      return
    }
    switcherRevealed = false
    DispatchQueue.main.async {
      withAnimation(Motion.settle.animation) { switcherRevealed = true }
    }
  }



  /// A swipe along the bar: the tab coming in beside the moving page.
  @ViewBuilder private var swipePictures: some View {
    if let tab = browser.swipeIncoming {
      let width = UIScreen.main.bounds.width + Self.swipeGap
      TabPicture(tab: tab, color: browser.pageColors[tab.id])
        .offset(x: browser.swipeOffset + (browser.swipeOffset < 0 ? width : -width))
    }
    if browser.swipeIncomingNew {
      newTabPicture.offset(x: browser.swipeOffset + UIScreen.main.bounds.width + Self.swipeGap)
    }
  }

  /// The new tab coming in past the last tab: the start page's wallpaper, and what it's for.
  private var newTabPicture: some View {
    ZStack {
      WallpaperView(id: app.preferences.wallpaper)
      VStack(spacing: Space.md) {
        BayIconView(.add, size: 40, color: BayColor.foreground.opacity(0.7))
        BayText(strings.t("tabs.newTab"), variant: .headline, tone: .overWallpaper)
      }
    }
    .ignoresSafeArea()
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  /// The gap between the page and the tab coming in beside it.
  private static let swipeGap: CGFloat = 12

  /// The bar's light or dark: the page's along its foot (else its top) while a page shows, the app's otherwise.
  private var barScheme: ColorScheme {
    guard browser.hasPage, browser.overlay == .none,
      let rgb = browser.pageBottomColors[app.activeTabId] ?? browser.pageColors[app.activeTabId], rgb.count >= 3
    else { return scheme }
    return isDarkColor(red: rgb[0], green: rgb[1], blue: rgb[2]) ? .dark : .light
  }

  /// Search opened over a dark page is dark too, so the sheet doesn't glare over it.
  private var searchOverDarkPage: Bool {
    guard browser.searchKeepsPage, let rgb = browser.pageColors[app.activeTabId], rgb.count >= 3 else { return false }
    return isDarkColor(red: rgb[0], green: rgb[1], blue: rgb[2])
  }

  /// The strip behind the status bar, in the colour at the top of the page, so the page seems to run under it.
  private var statusStrip: some View {
    let rgb = browser.pageColors[app.activeTabId]
    let color = rgb.map { Color(red: $0[0] / 255, green: $0[1] / 255, blue: $0[2] / 255) } ?? BayColor.background
    // A line at the top of the safe area whose background reaches up under the status bar.
    return VStack(spacing: 0) {
      Color.clear.frame(height: 0).background(color.ignoresSafeArea(edges: .top))
      Spacer(minLength: 0)
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  /// The start page: the whole screen opens search, with the pins and recent pages beside it.
  private var startScreen: some View {
    ZStack(alignment: .bottom) {
      Color.clear.contentShape(Rectangle())
        .onTapGesture { browser.search(inNewTab: false) }
        .accessibilityElement()
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(Text(verbatim: strings.t("start.tapToSearch")))
        .accessibilityIdentifier("start-screen")
      VStack(spacing: Space.xl) {
        StartPage(
          onOpen: { browser.open(.url($0), privately: false) },
          onUnpin: { site in
            Haptics.tick()
            browser.unpin(site)
          })
        // The bar's tip covers it, keeping its place.
        if browser.tip == .bar {
          searchHint.hidden()
        } else {
          searchHint
        }
      }
      .padding(.bottom, Self.barHeight + Space.xxl)
    }
  }

  /// "Tap to search", pointing down at the bar.
  private var searchHint: some View {
    VStack(spacing: 2) {
      BayText(strings.t("start.tapToSearch"), variant: .subhead, weight: .medium, tone: .muted)
      BayIconView(.down, size: IconSize.small, color: BayColor.muted)
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

/// A tab's picture where its page would be, or its title on a plain page when it has none yet.
struct TabPicture: View {
  let tab: BrowserTab
  let color: [Double]?
  /// Read as the picture first shows, so it never comes in blank.
  @State private var image: UIImage?

  init(tab: BrowserTab, color: [Double]?) {
    self.tab = tab
    self.color = color
    _image = State(initialValue: Self.load(tab.snapshot))
  }

  var body: some View {
    let back = color.flatMap { $0.count >= 3 ? Color(red: $0[0] / 255, green: $0[1] / 255, blue: $0[2] / 255) : nil } ?? BayColor.background
    ZStack(alignment: .top) {
      back
      if let image {
        // Across the width, top at the top, as the page lies: zoomed to fill, it didn't line up with the page.
        GeometryReader { geometry in
          Image(uiImage: image).resizable().aspectRatio(contentMode: .fit).frame(width: geometry.size.width)
        }
        .clipped()
      } else {
        VStack(spacing: Space.md) {
          SiteIcon(url: tab.url, size: 48)
          BayText(pageTitle(title: tab.title, url: tab.url), variant: .headline).multilineTextAlignment(.center).lineLimit(2)
          BayText(displayUrl(url: tab.url), variant: .footnote, tone: .muted).lineLimit(1)
        }
        .padding(Space.xl)
        .frame(maxHeight: .infinity)
      }
    }
    .ignoresSafeArea(edges: .bottom)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  /// A tab's picture at screen size, decoded now the first time (it must show in this frame) and kept by FileImages.
  static func load(_ snapshot: String?) -> UIImage? {
    guard let path = snapshot.flatMap(URL.init(string:))?.path else { return nil }
    let screen = UIScreen.main.bounds
    return FileImages.now(path, pixels: Int(max(screen.width, screen.height) * UIScreen.main.scale))
  }
}
