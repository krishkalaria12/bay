import BayCore
import BayDesign
import SwiftUI

/// The page menu's measures, as Arc Search draws it.
private enum MenuLayout {
  static let capsuleHeight: CGFloat = 47
  static let tilesGap: CGFloat = 17
  static let tileSpacing: CGFloat = 16
  static let tileHeight: CGFloat = 64
  static let tileRadius: CGFloat = 22
  static let rowHeight: CGFloat = 48
  static let zoomMin = 80
  static let zoomMax = 200
}

/// What to do with the page showing (bar-more): where to go, the four things done most, display options, this site,
/// the page's tools one step away, and what blocking did on it.
struct PageMenu: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel
  let onSettings: () -> Void
  // Rarely used page tools sit one step away, and the display options open in place, so the menu fits.
  @State private var tools = false
  @State private var display = false

  var body: some View {
    if tools {
      toolsPage
    } else {
      mainPage
    }
  }

  /// Closes the menu, then does what was picked.
  private func act(_ action: @escaping () -> Void) -> () -> Void {
    {
      browser.panel = nil
      action()
    }
  }

  private var mainPage: some View {
    let navigation = browser.activeNavigation
    let title = strings.t("pageMenu.title")
    let blocking = browser.blocking
    let zoom = browser.pageZoom
    return PanelSheet(
      title: title, testID: "page-menu", words: strings.sheetWords(title), onClose: { browser.panel = nil },
      header: AnyView(SiteHeader(browser: browser, blocking: blocking).environmentObject(strings).environmentObject(app))
    ) {
      SheetIconButton(.settings, label: strings.t("pageMenu.settings"), tone: .default, action: act(onSettings))
        .accessibilityIdentifier("page-settings")
    } content: {
      // The address capsule's controls: where to go, and a fresh tab.
      HStack(spacing: 0) {
        NavigationAction(id: "page-back", icon: .back, label: strings.t("pageMenu.back"), disabled: !navigation.canGoBack, action: act(browser.goBack))
        NavigationAction(
          id: "page-forward", icon: .forward, label: strings.t("pageMenu.forward"), disabled: !navigation.canGoForward, action: act(browser.goForward))
        if navigation.isLoading {
          NavigationAction(id: "page-stop", icon: .close, label: strings.t("pageMenu.stop"), action: act(browser.stop))
        } else {
          NavigationAction(id: "page-reload", icon: .reload, label: strings.t("pageMenu.reload"), action: act(browser.reload))
        }
        NavigationAction(id: "page-new-tab", icon: .add, label: strings.t("pageMenu.newTab"), action: act { browser.search(inNewTab: true) })
      }
      .padding(.horizontal, Space.xs)
      .background(BayColor.fill, in: Capsule())
      .padding(.top, Space.xs)

      HStack(alignment: .top, spacing: MenuLayout.tileSpacing) {
        Tile(id: "page-find", icon: .find, label: strings.t("pageMenu.find"), action: act(browser.startFind))
        let reading = browser.readerTab == app.activeTabId
        Tile(
          id: "page-reader", icon: .reader, label: strings.t("pageMenu.reader"),
          accessibilityLabel: strings.t(reading ? "pageMenu.readerSettings" : "pageMenu.reader"), active: reading,
          action: { browser.openReader() })
        let bookmarked = browser.isBookmarked
        Tile(
          id: "page-bookmark", icon: bookmarked ? .bookmarked : .bookmark, label: strings.t("pageMenu.bookmark"),
          accessibilityLabel: bookmarked ? strings.t("pageMenu.removeBookmark") : strings.t("pageMenu.bookmark"), active: bookmarked,
          action: act(browser.toggleBookmark))
        Tile(id: "page-share", icon: .share, label: strings.t("pageMenu.share"), action: act(browser.share))
      }
      .padding(.top, MenuLayout.tilesGap)

      RowGroup {
        ActionRow(
          strings.t("pageMenu.displayOptions"), testID: "page-display-options", icon: .textSize, value: zoom == 100 ? nil : "\(zoom)%",
          chevron: !display
        ) { withAnimation(.easeOut(duration: 0.2)) { display.toggle() } }
        if display {
          RowDivider()
          ActionRow(strings.t("pageMenu.translate"), testID: "page-translate", icon: .translate, action: act(browser.translate))
          RowDivider()
          ZoomRow(zoom: zoom, onZoom: browser.setZoom)
          RowDivider()
          let desktop = browser.siteSetting.desktopMode
          ActionRow(strings.t("site.desktop"), testID: "page-desktop", icon: .desktop, toggle: desktop) { browser.setDesktop(!desktop) }
        }
        RowDivider()
        ActionRow(strings.t("pageMenu.siteSettings"), testID: "page-site-settings", icon: .tune, chevron: true) { browser.panel = .siteSettings }
        RowDivider()
        ActionRow(strings.t("pageMenu.tools"), testID: "page-more-tools", icon: .more, chevron: true) { tools = true }
      }
      .padding(.top, Space.lg)

      if blocking != .off {
        BlockingCard(browser: browser, blocking: blocking, onRestore: act(browser.restoreOriginal))
          .padding(.top, Space.lg)
      }
    }
  }

  private var toolsPage: some View {
    let title = strings.t("pageMenu.toolsTitle")
    let pinned = browser.isPinned
    return PanelSheet(title: title, testID: "page-menu", words: strings.sheetWords(title), onClose: { browser.panel = nil }, onBack: { tools = false }) {
      VStack(spacing: Space.lg) {
        RowGroup {
          ActionRow(
            pinned ? strings.t("pageMenu.unpin") : strings.t("pageMenu.pinToStart"), testID: "page-pin", icon: pinned ? .unpin : .pin,
            action: act(browser.togglePin))
          RowDivider()
          ActionRow(strings.t("pageMenu.copyLink"), testID: "page-copy", icon: .link, action: act(browser.copyLink))
          RowDivider()
          ActionRow(strings.t("pageMenu.privateTab"), testID: "page-new-private", icon: .private, action: act { browser.search(inNewTab: true, privately: true) })
          RowDivider()
          ActionRow(
            strings.t("pageMenu.hideElements"), testID: "page-hide-elements", icon: .hide, detail: strings.t("pageMenu.hideElements.detail"),
            action: act { browser.startPicking(.hide) })
          RowDivider()
          ActionRow(
            strings.t("pageMenu.inspect"), testID: "page-inspect", icon: .inspect, detail: strings.t("pageMenu.inspect.detail"),
            action: act { browser.startPicking(.inspect) })
          let hidden = browser.activeHidden.count
          if hidden > 0 {
            RowDivider()
            ActionRow(
              hidden == 1 ? strings.t("pageMenu.hiddenOne") : strings.t("pageMenu.hiddenMany", ["count": "\(hidden)"]), testID: "page-show-hidden",
              icon: .visibility, action: act(browser.showHidden))
          }
          RowDivider()
          ActionRow(
            strings.t("pageMenu.markdown"), testID: "page-markdown", icon: .markdown, detail: strings.t("pageMenu.markdown.detail"),
            action: act(browser.copyMarkdown))
        }
        RowGroup {
          ActionRow(strings.t("pageMenu.history"), testID: "page-history", icon: .history, chevron: true) { browser.panel = .history }
          RowDivider()
          ActionRow(strings.t("pageMenu.downloads"), testID: "page-downloads", icon: .download, chevron: true) { browser.panel = .downloads }
          RowDivider()
          ActionRow(strings.t("pageMenu.archiveTab"), testID: "page-close-tab", icon: .archive, action: act { browser.archive(app.activeTabId) })
        }
      }
    }
  }
}

/// A round icon button for the navigation row: the icons say enough on their own.
private struct NavigationAction: View {
  let id: String
  let icon: BayIcon
  let label: String
  var disabled = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      BayIconView(icon, size: IconSize.control).frame(maxWidth: .infinity).frame(height: MenuLayout.capsuleHeight).contentShape(Rectangle())
    }
    .buttonStyle(.pressFeedback)
    .disabled(disabled)
    .opacity(disabled ? 0.35 : 1)
    .accessibilityLabel(Text(verbatim: label))
    .accessibilityIdentifier(id)
  }
}

/// A square with an icon and its label under it, four to a row.
private struct Tile: View {
  let id: String
  let icon: BayIcon
  let label: String
  var accessibilityLabel: String?
  var active = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: Space.sm) {
        BayIconView(icon, size: IconSize.control + 2, color: active ? BayColor.accent : BayColor.foreground)
          .frame(maxWidth: .infinity)
          .frame(height: MenuLayout.tileHeight)
          .background(active ? BayColor.accent.opacity(0.15) : BayColor.fill, in: RoundedRectangle(cornerRadius: MenuLayout.tileRadius, style: .continuous))
        BayText(label, variant: .caption, tone: active ? .accent : .default).lineLimit(1)
      }
    }
    .buttonStyle(.pressFeedback)
    .accessibilityLabel(Text(verbatim: accessibilityLabel ?? label))
    .accessibilityAddTraits(active ? .isSelected : [])
    .accessibilityIdentifier(id)
  }
}

/// Page zoom, a tenth at a time, kept for this site.
private struct ZoomRow: View {
  @EnvironmentObject private var strings: Strings
  let zoom: Int
  let onZoom: (Int) -> Void

  var body: some View {
    HStack(spacing: 14) {
      BayIconView(.textSize, size: IconSize.control)
      BayText(strings.t("site.zoom"))
      Spacer(minLength: 0)
      BayText("\(zoom)%", variant: .subhead, tone: .muted).accessibilityIdentifier("page-zoom-value")
      HStack(spacing: 0) {
        step("−", id: "page-zoom-out", label: strings.t("site.zoom.out"), disabled: zoom <= MenuLayout.zoomMin, up: false)
        step("+", id: "page-zoom-in", label: strings.t("site.zoom.in"), disabled: zoom >= MenuLayout.zoomMax, up: true)
      }
      .background(BayColor.fill, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
    }
    .padding(.leading, Space.lg)
    .padding(.trailing, Space.sm)
    .frame(minHeight: MenuLayout.rowHeight + 4)
  }

  private func step(_ glyph: String, id: String, label: String, disabled: Bool, up: Bool) -> some View {
    Button {
      let next = (Int((Double(zoom) / 10).rounded()) * 10) + (up ? 10 : -10)
      onZoom(min(MenuLayout.zoomMax, max(MenuLayout.zoomMin, next)))
    } label: {
      BayText(glyph, weight: .semibold).frame(width: 44, height: 36)
    }
    .buttonStyle(.pressFeedback)
    .disabled(disabled)
    .opacity(disabled ? 0.35 : 1)
    .accessibilityLabel(Text(verbatim: label))
    .accessibilityIdentifier(id)
  }
}

/// What blocking did on this page: the count where the engine has one, the switch for this site, and a way to see the
/// page as the site made it when blocking broke something.
private struct BlockingCard: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel
  let blocking: BrowserModel.PageBlocking
  let onRestore: () -> Void

  var body: some View {
    let count = browser.blocked[app.activeTabId] ?? 0
    let counted = blocking == .on && count > 0
    let label =
      counted ? (count == 1 ? strings.t("pageMenu.blockedOne") : strings.t("pageMenu.blockedCount", ["count": "\(count)"])) : strings.t("pageMenu.blocking")
    let detail =
      blocking == .paused
      ? strings.t("pageMenu.blocking.paused") : blocking == .restored ? strings.t("pageMenu.blocking.restored") : strings.t("pageMenu.blocking.on")
    RowGroup {
      ActionRow(label, testID: "page-blocking", icon: .shield, detail: detail, toggle: blocking == .on, action: browser.toggleBlocking)
      if blocking == .on {
        RowDivider()
        Button(action: onRestore) {
          HStack(spacing: 14) {
            BayIconView(.reload, size: IconSize.control)
            BayText(strings.t("pageMenu.restore"), variant: .subhead, tone: .muted)
            Spacer(minLength: 0)
          }
          .padding(.horizontal, Space.lg)
          .frame(minHeight: MenuLayout.rowHeight - 4)
          .contentShape(Rectangle())
        }
        .buttonStyle(.pressFeedback)
        .accessibilityLabel(Text(verbatim: strings.t("pageMenu.restore")))
        .accessibilityIdentifier("page-restore")
      }
    }
  }
}

/// The page's title and address, its site behind a lock (or a warning when it isn't encrypted), and what's blocked.
private struct SiteHeader: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel
  let blocking: BrowserModel.PageBlocking

  var body: some View {
    let url = browser.activeUrl
    let title = browser.activeNavigation.title.isEmpty ? (browser.activeTab?.title ?? "") : browser.activeNavigation.title
    let web = url.hasPrefix("http:") || url.hasPrefix("https:")
    let insecure = url.hasPrefix("http:")
    let status = [
      web ? (insecure ? strings.t("pageMenu.notSecure") : strings.t("pageMenu.secure")) : "",
      blocking == .on ? strings.t("pageMenu.blocked") : blocking == .off ? "" : strings.t("pageMenu.blockingPaused"),
    ].filter { !$0.isEmpty }.joined(separator: " · ")
    HStack(spacing: Space.md) {
      if !url.isEmpty { SiteIcon(url: url, size: 44) }
      VStack(alignment: .leading, spacing: 0) {
        BayText(title.isEmpty ? url : title, variant: .headline).lineLimit(1).accessibilityAddTraits(.isHeader)
        BayText(url, variant: .footnote, tone: .muted).lineLimit(1).accessibilityIdentifier("page-menu-url")
        if !status.isEmpty {
          HStack(spacing: Space.xs) {
            if web { BayIconView(insecure ? .error : .lock, size: IconSize.inline - 2, color: insecure ? BayColor.danger : BayColor.muted) }
            BayText(status, variant: .caption, weight: .regular, tone: insecure ? .danger : .muted).lineLimit(1)
          }
          .padding(.top, Space.xxs)
          .accessibilityElement(children: .ignore)
          .accessibilityLabel(Text(verbatim: status))
        }
      }
    }
  }
}

/// Find on page: sits above the keyboard in place of the bar, like Safari's.
struct FindBar: View {
  @EnvironmentObject private var strings: Strings
  @ObservedObject var browser: BrowserModel
  @FocusState private var focused: Bool

  var body: some View {
    let find = browser.find ?? .init()
    let matches = (find.count ?? 0) > 0
    let status =
      find.query.isEmpty || find.count == nil || find.foundFor != find.query
      ? "" : find.count == 0 ? strings.t("find.noMatches") : strings.t("find.matchCount", ["index": "\(find.index + 1)", "count": "\(find.count ?? 0)"])
    HStack(spacing: Space.xs) {
      HStack(spacing: Space.sm) {
        TextField(strings.t("find.placeholder"), text: Binding(get: { browser.find?.query ?? "" }, set: browser.findChanged))
          .focused($focused)
          .textInputAutocapitalization(.never)
          .disableAutocorrection(true)
          .submitLabel(.search)
          .onSubmit { browser.findStep(1) }
          .accessibilityLabel(Text(verbatim: strings.t("find.placeholder")))
          .accessibilityIdentifier("find-input")
        BayText(status, variant: .footnote, tone: .muted).accessibilityIdentifier("find-count")
      }
      .padding(.leading, Space.lg)
      .padding(.trailing, Space.md)
      .frame(height: 44)
      .background(BayColor.fill, in: Capsule())
      findButton(.up, id: "find-previous", label: strings.t("find.previous"), disabled: !matches) { browser.findStep(-1) }
      findButton(.down, id: "find-next", label: strings.t("find.next"), disabled: !matches) { browser.findStep(1) }
      Button(action: browser.endFind) {
        BayText(strings.t("find.done"), variant: .callout, weight: .semibold).padding(.horizontal, Space.md).frame(height: 44)
      }
      .buttonStyle(.pressFeedback)
      .accessibilityIdentifier("find-done")
    }
    .padding(Space.sm)
    .baySurface(radius: Radius.card)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("find-bar")
    .onAppear { focused = true }
  }

  private func findButton(_ icon: BayIcon, id: String, label: String, disabled: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      BayIconView(icon, size: 22).frame(width: 40, height: 44)
    }
    .buttonStyle(.pressFeedback)
    .disabled(disabled)
    .opacity(disabled ? 0.35 : 1)
    .accessibilityLabel(Text(verbatim: label))
    .accessibilityIdentifier(id)
  }
}
