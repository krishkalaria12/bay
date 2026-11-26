import BayCore
import BayDesign
import SwiftUI

/// A short notice at the top of the screen, under the status bar: a space's glyph and name, or where a bookmark went.
struct TopPill: View {
  @EnvironmentObject private var strings: Strings
  let note: TopNote
  let onDone: () -> Void

  var body: some View {
    Button {
      onDone()
      note.action?()
    } label: {
      HStack(spacing: Space.xs) {
        if let space = note.space {
          SpaceGlyph(space: space, name: note.text, size: 20)
        }
        BayText(note.text, variant: .subhead, weight: .semibold).lineLimit(1)
      }
      .padding(.horizontal, Space.md)
      .frame(minHeight: 36)
      .baySurface(radius: 18)
    }
    .buttonStyle(.pressFeedback)
    .disabled(note.action == nil)
    .accessibilityIdentifier("top-note")
    .transition(.move(edge: .top).combined(with: .opacity))
  }
}

/// One short message above the bar, with its action (Undo) when it has one.
struct ToastView: View {
  let toast: ToastMessage
  let onDone: () -> Void

  var body: some View {
    HStack(spacing: Space.sm) {
      BayText(toast.text, variant: .callout).lineLimit(2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier(toast.notice ? "reading-notice" : "toast")
      if let label = toast.actionLabel, let action = toast.action {
        Button {
          onDone()
          action()
        } label: {
          BayText(label, variant: .callout, weight: .semibold, tone: .accent)
            .padding(.horizontal, Space.lg)
            .frame(minHeight: 44)
        }
        .buttonStyle(.pressFeedback)
        .accessibilityIdentifier("toast-action")
      }
    }
    .padding(.leading, Space.lg)
    .padding(.trailing, toast.action == nil ? Space.lg : Space.xs + 2)
    .padding(.vertical, toast.action == nil ? Space.md : Space.xs + 2)
    .baySurface(radius: Radius.card)
    .transition(.move(edge: .bottom).combined(with: .opacity))
  }
}

/// Media playing in a tab that isn't on screen: tap to go back to it, play or pause it, skip ten seconds, or stop it.
struct MiniPlayer: View {
  @EnvironmentObject private var strings: Strings
  @ObservedObject var browser: BrowserModel
  let tab: BrowserTab
  let media: TabMedia

  var body: some View {
    let title = media.report.title.isEmpty ? tab.title : media.report.title
    let playing = media.report.playing
    HStack(spacing: 4) {
      Button {
        browser.activate(tab.id)
      } label: {
        VStack(alignment: .leading, spacing: 0) {
          BayText(title, variant: .callout, weight: .medium).lineLimit(1)
          BayText(hostOf(url: tab.url), variant: .footnote, tone: .muted).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(
        Text(verbatim: "\(title), \(playing ? strings.t("player.playing") : strings.t("player.paused")). \(strings.t("player.goToTab"))"))
      .accessibilityIdentifier("mini-player")
      control(.back, strings.t("player.backTen"), "mini-player-back") { browser.seekMedia(tab.id, by: -10) }
      control(playing ? .pause : .play, playing ? strings.t("player.pause") : strings.t("player.play"), "mini-player-toggle", strong: true) {
        browser.toggleMedia(tab.id)
      }
      control(.forward, strings.t("player.forwardTen"), "mini-player-forward") { browser.seekMedia(tab.id, by: 10) }
      if media.report.video {
        control(.pip, strings.t("player.pictureInPicture"), "mini-player-pip") { browser.pictureInPicture(tab.id) }
      }
      control(.close, strings.t("player.stopAndClose"), "mini-player-close") { browser.stopMedia(tab.id) }
    }
    .padding(.vertical, Space.xs + 2)
    .padding(.leading, Space.md + 2)
    .padding(.trailing, Space.xs + 2)
    .baySurface(radius: Radius.card)
  }

  private func control(_ icon: BayIcon, _ label: String, _ id: String, strong: Bool = false, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      BayIconView(icon, size: strong ? 22 : 20, color: strong ? BayColor.foreground : BayColor.muted).frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(Text(verbatim: label))
    .accessibilityIdentifier(id)
  }
}

/// Covers a private page after Bay has been in the background, until Face ID, Touch ID or the passcode unlocks it.
struct PrivateLockView: View {
  @EnvironmentObject private var strings: Strings
  let onUnlock: () -> Void

  var body: some View {
    let ink = Color(RGBA(0xF4, 0xF4, 0xF5))
    VStack(spacing: Space.lg) {
      BayIconView(.lock, size: 34, color: ink)
      BayText(strings.t("lock.title"), variant: .headline, color: ink).accessibilityAddTraits(.isHeader)
      Button(action: onUnlock) {
        BayText(strings.t("lock.unlock"), color: ink)
          .padding(.horizontal, Space.xl)
          .frame(minHeight: 48)
          .background(Color.white.opacity(0.15), in: Capsule())
      }
      .buttonStyle(.pressFeedback)
      .accessibilityIdentifier("private-unlock")
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color(RGBA(0x0A, 0x0A, 0x0A)).ignoresSafeArea())
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("private-lock")
  }
}

/// A card in the switcher growing into its page: the tab's picture moves from the card's place to the whole screen,
/// A tab between its card in the switcher and its page: growing out of the card when it's picked, shrinking into it as
/// the switcher opens. It's the tab's picture, else its page's colour with its icon (a new tab: the wallpaper). Without a
/// card to go to, it shrinks to the middle of the screen, fading.
struct TabMorph: View {
  let tab: BrowserTab
  let color: [Double]?
  let wallpaper: WallpaperId
  /// The card's place on screen, read as the morph starts: the switcher lays its cards out on the same turn.
  let card: () -> CGRect?
  /// From the page into the card (the switcher opening), else from the card to the page.
  let shrinking: Bool
  let onDone: () -> Void
  @State private var atCard: Bool
  @State private var cardRect: CGRect?
  private let picture: UIImage?

  init(
    tab: BrowserTab, color: [Double]?, wallpaper: WallpaperId, card: @escaping () -> CGRect?, shrinking: Bool,
    onDone: @escaping () -> Void
  ) {
    self.tab = tab
    self.color = color
    self.wallpaper = wallpaper
    self.card = card
    self.shrinking = shrinking
    self.onDone = onDone
    _atCard = State(initialValue: !shrinking)
    _cardRect = State(initialValue: shrinking ? nil : card())
    picture = TabPicture.load(tab.snapshot)
  }

  private var spring: BaySpring { shrinking ? Motion.settle : Motion.open }

  /// How long a shrink waits for the switcher to place the card it lands on.
  private static let cardSettle: Double = 0.05

  var body: some View {
    GeometryReader { geometry in
      let screen = geometry.frame(in: .global)
      let page = CGRect(x: 0, y: screen.minY + geometry.safeAreaInsets.top, width: screen.width, height: screen.height - geometry.safeAreaInsets.top)
      let rect = atCard ? (cardRect ?? page.insetBy(dx: page.width / 4, dy: page.height / 4)) : page
      content(width: rect.width)
        .frame(width: rect.width, height: rect.height, alignment: .top)
        .clipShape(RoundedRectangle(cornerRadius: atCard ? Radius.tile : 0, style: .continuous))
        .opacity(atCard && cardRect == nil ? 0 : 1)
        .position(x: rect.midX - screen.minX, y: rect.midY - screen.minY)
    }
    .ignoresSafeArea()
    .allowsHitTesting(false)
    .accessibilityHidden(true)
    .onAppear {
      // Shrinking, a moment later: the switcher has laid its cards out and scrolled to this one by then.
      DispatchQueue.main.asyncAfter(deadline: .now() + (shrinking ? Self.cardSettle : 0)) {
        if shrinking { cardRect = card() }
        withAnimation(spring.animation) { atCard = shrinking }
        // The grid can still be settling as the shrink starts: the card's latest place steers the rest of the way.
        if shrinking {
          DispatchQueue.main.asyncAfter(deadline: .now() + spring.response / 3) {
            if let again = card(), again != cardRect { withAnimation(spring.animation) { cardRect = again } }
          }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + spring.response, execute: onDone)
      }
    }
  }

  /// The picture across the whole width, its top at the top, as the page lies: cut off below, never zoomed to fill.
  @ViewBuilder private func content(width: CGFloat) -> some View {
    if let picture {
      Image(uiImage: picture).resizable().aspectRatio(contentMode: .fit).frame(width: width)
    } else if tab.url.isEmpty {
      WallpaperView(id: wallpaper)
    } else {
      let back = color.flatMap { $0.count >= 3 ? Color(red: $0[0] / 255, green: $0[1] / 255, blue: $0[2] / 255) : nil } ?? BayColor.background
      ZStack {
        back
        SiteIcon(url: tab.url, size: 48)
      }
    }
  }
}
