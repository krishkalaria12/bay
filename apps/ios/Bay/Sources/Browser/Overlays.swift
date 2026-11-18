import BayCore
import BayDesign
import SwiftUI

/// One short message above the bar, with its action (Undo) when it has one.
struct ToastView: View {
  let toast: ToastMessage
  let onDone: () -> Void

  var body: some View {
    HStack(spacing: Space.sm) {
      BayText(toast.text, variant: .callout).lineLimit(2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("toast")
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
/// with the quick open spring, and the page takes over when it lands.
struct TabZoom: View {
  let snapshot: UIImage
  let from: CGRect
  let onDone: () -> Void
  @State private var grown = false

  var body: some View {
    GeometryReader { geometry in
      let screen = geometry.frame(in: .global)
      let target = CGRect(x: 0, y: screen.minY + geometry.safeAreaInsets.top, width: screen.width, height: screen.height - geometry.safeAreaInsets.top)
      let rect = grown ? target : from
      Image(uiImage: snapshot)
        .resizable()
        .scaledToFill()
        .frame(width: rect.width, height: rect.height, alignment: .top)
        .clipShape(RoundedRectangle(cornerRadius: grown ? 0 : Radius.tile, style: .continuous))
        .position(x: rect.midX - screen.minX, y: rect.midY - screen.minY)
    }
    .ignoresSafeArea()
    .allowsHitTesting(false)
    .accessibilityHidden(true)
    .onAppear {
      withAnimation(Motion.open.animation) { grown = true }
      DispatchQueue.main.asyncAfter(deadline: .now() + Motion.open.response, execute: onDone)
    }
  }
}
