import BayCore
import BayDesign
import BayEngine
import SwiftUI

/// Bay's one screen: the page showing (or the start page), the floating bar, and what opens over them.
struct BrowserScreen: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel
  /// Settings, while it is still the stand-in screen (plan N5).
  let onSettings: () -> Void

  private static let barHeight: CGFloat = 52

  var body: some View {
    ZStack(alignment: .bottom) {
      WallpaperView(id: app.preferences.wallpaper)
      // The pages stay in place under the switcher, so a page isn't torn down and reloaded on the way back.
      if browser.hasPage || !browser.mounted.isEmpty {
        PagesHost(browser: browser)
          .ignoresSafeArea(edges: .bottom)
          .opacity(browser.hasPage && browser.overlay != .tabs ? 1 : 0)
          .allowsHitTesting(browser.hasPage && browser.overlay != .tabs)
          .accessibilityHidden(!browser.hasPage || browser.overlay == .tabs)
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
      if browser.overlay != .search {
        BrowserBar(browser: browser, onSettings: onSettings)
          .padding(.horizontal, Space.edge)
          .padding(.bottom, Space.xs)
      }
      if browser.overlay == .search {
        SearchCard(
          browser: browser, initialText: browser.searchInNewTab ? "" : (browser.activeTab?.url ?? ""),
          privately: browser.searchPrivately || (browser.activeTab?.private ?? false))
      }
    }
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
            app.dispatch(.removePin(id: site.id))
          })
        VStack(spacing: 2) {
          BayText(strings.t("start.tapToSearch"), variant: .subhead, weight: .medium, tone: .muted)
          BayIconView(.down, size: IconSize.small, color: BayColor.muted)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
      }
      .padding(.bottom, Self.barHeight + Space.xxl)
    }
  }
}
