import BayCore
import BayDesign
import SwiftUI

/// The page menu's measures.
private enum MenuLayout {
  static let addressHeight: CGFloat = 48
  static let tileHeight: CGFloat = 76
  static let rowHeight: CGFloat = 52
  static let zoomMin = 80
  static let zoomMax = 200
}

/// What to do with the page showing (bar-more), as one floating sheet: the address with back, forward, copy and reload
/// on top; Share, Pin, Save and Find; this site's settings and Developer tools a step away; Reader, Hide elements,
/// Translate and the page's zoom;
/// Bookmarks, History, Downloads and Settings.
struct PageMenu: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel
  let onSettings: () -> Void
  @State private var tools = false

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
    let title = strings.t("pageMenu.title")
    let zoom = browser.pageZoom
    let reading = browser.readerTab == app.activeTabId
    let readerHere = browser.siteSetting.reader
    return PanelSheet(
      title: title, testID: "page-menu", words: strings.sheetWords(title), onClose: { browser.panel = nil },
      header: AnyView(AddressRow(browser: browser, act: act).environmentObject(strings).environmentObject(app))
    ) {
      HStack(spacing: Space.sm) {
        Tile(id: "page-share", icon: .share, label: strings.t("pageMenu.share"), action: act(browser.share))
        let pinned = browser.isPinned
        Tile(
          id: "page-pin", icon: pinned ? .unpin : .pin, label: strings.t("pageMenu.pin"),
          accessibilityLabel: strings.t(pinned ? "pageMenu.unpin" : "pageMenu.pinToStart"), active: pinned, action: act(browser.togglePin))
        let bookmarked = browser.isBookmarked
        Tile(
          id: "page-bookmark", icon: bookmarked ? .bookmarked : .bookmark, label: strings.t("pageMenu.save"),
          accessibilityLabel: strings.t(bookmarked ? "pageMenu.removeBookmark" : "pageMenu.bookmark"), active: bookmarked,
          action: act(browser.toggleBookmark))
        Tile(id: "page-find", icon: .find, label: strings.t("pageMenu.find"), action: act(browser.startFind))
      }

      VStack(spacing: Space.md) {
        RowGroup {
          ActionRow(strings.t("pageMenu.siteSettings"), testID: "page-site-settings", icon: .tune, chevron: true) { browser.panel = .siteSettings }
          RowDivider()
          ActionRow(strings.t("pageMenu.developerTools"), testID: "page-more-tools", icon: .tools, chevron: true) { tools = true }
        }
        RowGroup {
          ListRow(
            label: strings.t(reading ? "pageMenu.readerSettings" : "pageMenu.showReader"), testID: "page-reader", icon: .reader,
            primary: { browser.openReader() }
          ) {
            Button(strings.t(reading ? "pageMenu.readerSettings" : "pageMenu.showReader")) { browser.openReader() }
            if reading {
              Button(strings.t("reader.exit")) { act(browser.exitReader)() }
            }
            Button {
              browser.changeSiteSetting { $0.reader = !readerHere }
            } label: {
              if readerHere {
                Label(strings.t("site.reader"), systemImage: "checkmark")
              } else {
                Text(verbatim: strings.t("site.reader"))
              }
            }
          }
          RowDivider()
          ActionRow(strings.t("pageMenu.hideElements"), testID: "page-hide-elements", icon: .hide, action: act { browser.startPicking(.hide) })
          RowDivider()
          ListRow(label: strings.t("pageMenu.translatePage"), testID: "page-translate", icon: .translate, primary: act { browser.translate() }) {
            ForEach(translationLanguages, id: \.id) { language in
              Button(language.name) { act { browser.translate(to: language.id) }() }
            }
          }
          RowDivider()
          ZoomRow(zoom: zoom, onZoom: browser.setZoom)
        }
        RowGroup {
          ActionRow(strings.t("pageMenu.bookmarks"), testID: "page-bookmarks", icon: .bookmark, chevron: true) { browser.panel = .bookmarks }
          RowDivider()
          ActionRow(strings.t("pageMenu.history"), testID: "page-history", icon: .history, chevron: true) { browser.panel = .history }
          RowDivider()
          ActionRow(strings.t("pageMenu.downloads"), testID: "page-downloads", icon: .download, chevron: true) { browser.panel = .downloads }
          RowDivider()
          ActionRow(strings.t("pageMenu.settings"), testID: "page-settings", icon: .settings, chevron: true, action: act(onSettings))
        }
      }
      .padding(.top, Space.md)
    }
  }

  /// Bay's languages to translate into, the one it's in first.
  private var translationLanguages: [LocaleInfo] {
    let all = locales()
    let current = strings.locale
    return all.filter { $0.id == current } + all.filter { $0.id != current }
  }

  private var toolsPage: some View {
    let title = strings.t("pageMenu.developerTools")
    let hidden = browser.activeHidden.count
    return PanelSheet(title: title, testID: "page-menu", words: strings.sheetWords(title), onClose: { browser.panel = nil }, onBack: { tools = false }) {
      VStack(spacing: Space.md) {
        RowGroup {
          ActionRow(
            strings.t("pageMenu.inspect"), testID: "page-inspect", icon: .inspect, detail: strings.t("pageMenu.inspect.detail"),
            action: act { browser.startPicking(.inspect) })
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
          ActionRow(strings.t("pageMenu.privateTab"), testID: "page-new-private", icon: .private, action: act { browser.search(inNewTab: true, privately: true) })
          RowDivider()
          ActionRow(strings.t("pageMenu.archiveTab"), testID: "page-close-tab", icon: .archive, action: act { browser.archive(app.activeTabId) })
        }
      }
    }
  }
}

/// The page's address in one capsule: back and forward at its left, the lock (or a warning) and the address cut short
/// at its end, and copy and reload (or stop) at its right. Tapping the address opens search with it filled in.
private struct AddressRow: View {
  @EnvironmentObject private var strings: Strings
  @ObservedObject var browser: BrowserModel
  let act: (@escaping () -> Void) -> () -> Void

  var body: some View {
    let navigation = browser.activeNavigation
    let url = browser.activeUrl
    let insecure = url.hasPrefix("http:")
    HStack(spacing: 0) {
      icon(.back, id: "page-back", label: strings.t("pageMenu.back"), disabled: !navigation.canGoBack, action: act(browser.goBack))
      icon(.forward, id: "page-forward", label: strings.t("pageMenu.forward"), disabled: !navigation.canGoForward, action: act(browser.goForward))
      Button(action: act { browser.search(inNewTab: false) }) {
        HStack(spacing: Space.xs) {
          BayIconView(insecure ? .error : .lock, size: IconSize.inline, color: insecure ? BayColor.danger : BayColor.muted)
          BayText(displayUrl(url: url), variant: .callout).lineLimit(1).truncationMode(.tail)
            .accessibilityIdentifier("page-menu-url")
          Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, minHeight: MenuLayout.addressHeight)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(Text(verbatim: "\(strings.t(insecure ? "pageMenu.notSecure" : "pageMenu.secure")), \(url)"))
      icon(.link, id: "page-copy", label: strings.t("pageMenu.copyLink"), action: act(browser.copyLink))
      if navigation.isLoading {
        icon(.close, id: "page-stop", label: strings.t("pageMenu.stop"), action: act(browser.stop))
      } else {
        icon(.reload, id: "page-reload", label: strings.t("pageMenu.reload"), action: act(browser.reload))
      }
    }
    .padding(.horizontal, Space.xs)
    .background(BayColor.background, in: Capsule())
    .overlay(Capsule().strokeBorder(BayColor.hairline, lineWidth: 1))
  }

  private func icon(_ icon: BayIcon, id: String, label: String, disabled: Bool = false, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      BayIconView(icon, size: IconSize.row, color: disabled ? BayColor.muted.opacity(0.5) : BayColor.foreground)
        .frame(width: 40, height: MenuLayout.addressHeight)
        .contentShape(Rectangle())
    }
    .buttonStyle(.pressFeedback)
    .disabled(disabled)
    .accessibilityLabel(Text(verbatim: label))
    .accessibilityIdentifier(id)
  }
}

/// A rounded square with an icon over its label, four to a row.
private struct Tile: View {
  let id: String
  let icon: BayIcon
  let label: String
  var accessibilityLabel: String?
  var active = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: Space.xs) {
        BayIconView(icon, size: IconSize.control, color: active ? BayColor.accent : BayColor.foreground)
        BayText(label, variant: .caption, weight: .medium, tone: active ? .accent : .default).lineLimit(1)
      }
      .frame(maxWidth: .infinity)
      .frame(height: MenuLayout.tileHeight)
      .background(active ? BayColor.accent.opacity(0.15) : BayColor.fill, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
    }
    .buttonStyle(.pressFeedback)
    .accessibilityLabel(Text(verbatim: accessibilityLabel ?? label))
    .accessibilityAddTraits(active ? .isSelected : [])
    .accessibilityIdentifier(id)
  }
}

/// A row that does its main thing when tapped and offers a short list behind ⌃⌄ (Reader's choices, Translate's
/// languages); VoiceOver gets the list as the row's actions.
private struct ListRow<Items: View>: View {
  let label: String
  let testID: String
  let icon: BayIcon
  let primary: () -> Void
  @ViewBuilder let items: () -> Items

  var body: some View {
    HStack(spacing: 0) {
      Button(action: primary) {
        HStack(spacing: 14) {
          BayIconView(icon, size: IconSize.control)
          BayText(label).lineLimit(1)
          Spacer(minLength: 0)
        }
        .padding(.leading, Space.lg)
        .frame(minHeight: MenuLayout.rowHeight)
        .contentShape(Rectangle())
      }
      .buttonStyle(.pressFeedback)
      .accessibilityIdentifier(testID)
      Menu(content: items) {
        BayIconView(.unfold, size: IconSize.small, color: BayColor.muted)
          .frame(width: 52, height: MenuLayout.rowHeight)
          .contentShape(Rectangle())
      }
      .accessibilityLabel(Text(verbatim: label))
      .accessibilityIdentifier("\(testID)-choices")
    }
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
      BayText(strings.percent(zoom), variant: .subhead, tone: .muted).accessibilityIdentifier("page-zoom-value")
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
struct BlockingCard: View {
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
