import BayCore
import BayDesign
import BayEngine
import SwiftUI

/// Bay's one screen: the page showing (or the start page), the floating bar, and what opens over them.
struct BrowserScreen: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel
  let onSettings: () -> Void
  /// The stand-in check screens, for testing.
  var onChecks: () -> Void = {}

  private static let barHeight: CGFloat = 52
  /// The screen's bottom safe area (the home indicator), which the bar sits above.
  @State private var safeBottom: CGFloat = 0

  /// What the floating bar covers at the bottom of a page: from the screen's edge up past its top, with a little room.
  private var coveredBottom: CGFloat {
    browser.barHidden && browser.overlay == .none ? 0 : max(safeBottom, Space.md) + Space.xs + Self.barHeight + Space.sm
  }

  var body: some View {
    ZStack(alignment: .bottom) {
      WallpaperView(id: app.preferences.wallpaper)
      // The pages stay in place under the switcher, so a page isn't torn down and reloaded on the way back.
      if browser.hasPage || !browser.mounted.isEmpty {
        let shown = browser.hasPage && browser.overlay != .tabs && !browser.covered
        PagesHost(browser: browser, shown: shown, coveredBottom: coveredBottom)
          .ignoresSafeArea(edges: .bottom)
          .opacity(shown ? 1 : 0)
          .allowsHitTesting(shown)
      }
      if browser.overlay == .tabs {
        WallpaperView(id: app.preferences.wallpaper)
        TabSwitcher(browser: browser, onSettings: onSettings)
      } else if browser.hasPage {
        if let failure = browser.failure, failure.tabId == app.activeTabId {
          PageErrorView(message: failure.message, retry: browser.retry)
        }
        statusStrip
      } else if browser.overlay == .none {
        startScreen
      }
      if let zoom = browser.zoom, let path = zoom.tab.snapshot.flatMap(URL.init(string:))?.path, let image = UIImage(contentsOfFile: path) {
        TabZoom(snapshot: image, from: zoom.frame, onDone: browser.zoomFinished)
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
              // The ring round the capsule the tip means.
              .overlay {
                if browser.tip == .bar {
                  // The capsule is narrower over the start page, where it holds only the magnifier.
                  Capsule().stroke(BayColor.accent, lineWidth: 2.5).frame(width: browser.hasPage ? 184 : 140, height: 62)
                    .allowsHitTesting(false)
                }
              }
          }
        }
        .padding(.horizontal, Space.edge)
        .padding(.bottom, Space.xs)
        // Scrolled away while the page scrolls down; the toast and player go with it.
        .offset(y: browser.barHidden && browser.overlay == .none ? 140 : 0)
        .animation(.easeOut(duration: 0.2), value: browser.barHidden)
        .animation(.easeOut(duration: 0.2), value: browser.toast?.id)
      }
      if browser.overlay == .search {
        SearchCard(
          browser: browser, initialText: browser.searchInNewTab ? "" : (browser.activeTab?.url ?? ""),
          // A new tab starts as a normal one unless asked for private; editing a private tab's address stays private.
          privately: browser.searchPrivately || (!browser.searchInNewTab && (browser.activeTab?.private ?? false)))
      }
    }
    .background(
      GeometryReader { proxy in
        Color.clear
          .onAppear { safeBottom = proxy.safeAreaInsets.bottom }
          .onChange(of: proxy.safeAreaInsets.bottom) { safeBottom = $0 }
      }
    )
    .baySheet(isPresented: Binding(get: { browser.panel != nil }, set: { if !$0 { browser.panel = nil } }), maxFraction: 0.88) {
      Group {
        switch browser.panel {
        case .page:
          PageMenu(browser: browser, onSettings: onSettings)
        case .spaceEdit:
          if let space = browser.activeSpace { SpaceEditPanel(browser: browser, space: space) }
        case .archive:
          ArchivePanel(browser: browser)
        case .history:
          HistoryPanel(browser: browser)
        case .bookmarks:
          BookmarksPanel(browser: browser)
        case .downloads:
          DownloadsPanel(browser: browser)
        case .import:
          ImportPanel(browser: browser)
        case .siteSettings:
          SiteSettingsPanel(browser: browser, onSettings: onSettings)
        case .link:
          if let link = browser.link { LinkMenu(browser: browser, link: link) }
        case .tabs:
          TabsMenu(browser: browser)
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
    .onAppear(perform: browser.refreshMounted)
    .onChange(of: app.activeTabId) { _ in browser.refreshMounted() }
    .onChange(of: app.tabs.map(\.url)) { _ in browser.refreshMounted() }
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
