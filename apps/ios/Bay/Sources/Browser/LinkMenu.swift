import BayCore
import BayDesign
import BayEngine
import SwiftUI

/// The preview's height, above the menu's rows.
private let peekHeight: CGFloat = 200

/// A long-pressed link's (or bare image's) menu: the linked page live in a card, then what to do with it. For a link,
/// "Where does it go?" follows its redirects and says where it ends.
struct LinkMenu: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var browser: BrowserModel
  let link: LinkPress
  @State private var resolving = false
  /// The answer once one came: the destination, or nil when the link couldn't be reached.
  @State private var answer: String??

  var body: some View {
    let title = strings.t("linkMenu.title")
    let tab = browser.activeTab
    // A link on a private page opens privately, in front or behind.
    let privately = tab?.private ?? false
    PanelSheet(title: title, testID: "link-menu", words: strings.sheetWords(title), onClose: close) {
      // A link to a site that keeps its desktop page previews it that way too.
      Peek(
        url: link.url, privately: privately, profile: tab?.spaceId ?? app.activeSpaceId,
        desktopMode: app.store.siteSetting(url: link.url).desktopMode
      )
      .id(link.url)
      if !link.title.isEmpty, link.title != link.url {
        BayText(link.title, variant: .callout, weight: .medium).lineLimit(2).padding(.horizontal, Space.xs)
      }
      BayText(link.url, variant: .footnote, tone: .muted).lineLimit(3)
        .padding(.horizontal, Space.xs)
        .padding(.bottom, Space.lg)
        .accessibilityIdentifier("link-menu-url")
      RowGroup {
        if link.image {
          ActionRow(strings.t("linkMenu.openImage"), testID: "link-open-tab", icon: .add, action: act { browser.openTab(link.url, privately: privately) })
          RowDivider()
          ActionRow(strings.t("linkMenu.copyImage"), testID: "link-image-copy", icon: .copy, action: act { browser.copy(link.url) })
          RowDivider()
          ActionRow(strings.t("linkMenu.shareImage"), testID: "link-image-share", icon: .share, action: act { browser.share(link.url) })
          RowDivider()
          ActionRow(strings.t("linkMenu.saveImage"), testID: "link-image-save", icon: .download, action: act { browser.saveImage(link.url) })
        } else {
          ActionRow(strings.t("linkMenu.openTab"), testID: "link-open-tab", icon: .add, action: act { browser.openTab(link.url, privately: privately) })
          RowDivider()
          ActionRow(
            strings.t("linkMenu.openBackground"), testID: "link-open-background", icon: .tabs,
            action: act { browser.openTab(link.url, privately: privately, background: true) })
          RowDivider()
          ActionRow(strings.t("linkMenu.copyLink"), testID: "link-copy", icon: .link, action: act { browser.copy(link.url) })
          RowDivider()
          ActionRow(strings.t("linkMenu.share"), testID: "link-share", icon: .share, action: act { browser.share(link.url) })
          RowDivider()
          ActionRow(
            resolving ? strings.t("linkMenu.checking") : strings.t("linkMenu.where"), testID: "link-destination", icon: .forward,
            disabled: resolving, action: resolve)
        }
      }
      if case .some(.some(let destination)) = answer {
        VStack(alignment: .leading, spacing: Space.xs) {
          BayText(strings.t("linkMenu.destination"), variant: .subhead, tone: .muted)
          Text(verbatim: destination).font(.system(size: TextVariant.body.size)).foregroundColor(BayColor.foreground)
            .textSelection(.enabled)
            .accessibilityIdentifier("link-destination-result")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Space.lg)
        .background(BayColor.fill, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .padding(.top, Space.md)
      } else if case .some(.none) = answer {
        BayText(strings.t("linkMenu.unreachable"), variant: .subhead, tone: .danger)
          .padding(.top, Space.md)
          .accessibilityIdentifier("link-destination-error")
      }
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

  private func resolve() {
    guard !resolving else { return }
    resolving = true
    answer = nil
    let url = link.url
    Task {
      let destination = await resolveLink(http: app.http, url: url)
      // The menu may have moved on to another link meanwhile.
      guard browser.link?.url == url else { return }
      answer = .some(destination)
      resolving = false
    }
  }
}

/// The link's page, live, in a card of its own. Nothing of it stays (no saved state, a private store when the tab is
/// private) and nothing of it is answerable (dialogs, sign-ins and app links are turned down as soon as they arrive),
/// so a preview can't change the session.
private struct Peek: View {
  let url: String
  let privately: Bool
  let profile: String
  let desktopMode: Bool
  @StateObject private var state = PeekState()

  var body: some View {
    ZStack(alignment: .topLeading) {
      PeekView(url: url, privately: privately, profile: profile, desktopMode: desktopMode, state: state)
      if state.loading {
        GeometryReader { box in
          Capsule().fill(BayColor.accent).frame(width: box.size.width * max(0.08, state.progress), height: 2)
        }
      }
    }
    .frame(height: peekHeight)
    .background(BayColor.fill)
    .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
    .allowsHitTesting(false)
    .accessibilityHidden(true)
    .padding(.bottom, Space.md)
    .accessibilityIdentifier("link-preview")
  }
}

@MainActor
private final class PeekState: ObservableObject {
  @Published var loading = true
  @Published var progress = 0.0
}

private struct PeekView: UIViewRepresentable {
  let url: String
  let privately: Bool
  let profile: String
  let desktopMode: Bool
  let state: PeekState

  func makeUIView(context: Context) -> EngineView {
    let view = EngineView(isPrivate: privately, profile: profile)
    view.desktopMode = desktopMode
    view.pullToRefreshEnabled = false
    view.appLinks = .browser
    view.isUserInteractionEnabled = false
    let state = state
    view.onEvent = { [weak view] event in
      MainActor.assumeIsolated {
        switch event {
        case .navigation(let navigation):
          state.progress = navigation.progress
          state.loading = navigation.isLoading
        case .pageRequest(let request):
          // No one is there to answer the preview's questions: refuse at once, or the page waits forever.
          view?.answerPageRequest(id: request.id, accepted: false, value: nil, username: nil, password: nil)
        default:
          break
        }
      }
    }
    view.loadInitial(url)
    return view
  }

  func updateUIView(_ view: EngineView, context: Context) {}
}
