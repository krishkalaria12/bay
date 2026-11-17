import Foundation
import MediaPlayer

/// System media controls (I1): Now Playing info and remote commands for the lock screen and Control Center, as
/// Android's BayMediaService does with its media notification. iOS previously had no `setMediaSession` at all, so
/// `useTabMedia`'s call was a silent no-op and `onMediaControl` was never sent; WebKit does not populate the
/// Now Playing center for WKWebView media the way it does for AVPlayer, so Bay posts it itself from the page's own
/// media report (title, site, playing). The Info Center is written only while media exists, and cleared when the
/// session goes to null — matching BayMedia.clear on Android. Private tabs never reach here (`useTabMedia` excludes
/// them from the session tab).
final class BayMedia: NSObject {
  static let shared = BayMedia()

  /// Set by the module: sends an `onMediaControl` event with "toggle", "stop", "skip-forward" or "skip-backward".
  var emit: ((String) -> Void)?

  private var registered = false

  /// Mirrors BayMedia.update: only playing media posts info that keeps the system controls alive.
  func update(title: String, site: String, playing: Bool) {
    registerCommands()
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: title,
      MPMediaItemPropertyArtist: site,
      MPMediaItemPropertyMediaType: MPMediaType.anyAudio.rawValue,
      MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
    ]
    // If WebKit is already driving playback (e.g. a fullscreen player), don't fight it with a stale position:
    // keep the previous elapsed time when we would otherwise reset the scrubber to zero.
    if let current = MPNowPlayingInfoCenter.default().nowPlayingInfo {
      if let elapsed = current[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? Double {
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = elapsed
        info[MPMediaItemPropertyPlaybackDuration] = (current[MPMediaItemPropertyPlaybackDuration] as? Double) ?? 0.0
      }
    }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
  }

  func clear() {
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
  }

  /// Play/pause map to Android's "toggle" (the page toggles itself), stop to "stop". Registered once, on the main
  /// thread; the targets only forward the event the module already declares.
  private func registerCommands() {
    guard !registered else { return }
    registered = true
    let center = MPRemoteCommandCenter.shared()
    let emit = { [weak self] (action: String) in self?.emit?(action) }
    // Each registration returns an autoreleasing token; retaining the targets via the center is the documented
    // pattern (removing them would require the tokens, which Bay never needs to do).
    center.playCommand.addTarget { _ in
      DispatchQueue.main.async { emit("toggle") }
      return .success
    }
    center.pauseCommand.addTarget { _ in
      DispatchQueue.main.async { emit("toggle") }
      return .success
    }
    center.togglePlayPauseCommand.addTarget { _ in
      DispatchQueue.main.async { emit("toggle") }
      return .success
    }
    center.stopCommand.addTarget { _ in
      DispatchQueue.main.async { emit("stop") }
      return .success
    }
    // The mini player's skip (B17): ten seconds either way, matching the page's seek.
    center.skipForwardCommand.addTarget { _ in
      DispatchQueue.main.async { emit("skip-forward") }
      return .success
    }
    center.skipBackwardCommand.addTarget { _ in
      DispatchQueue.main.async { emit("skip-backward") }
      return .success
    }
    // Remote commands start disabled on some iOS versions; the lock screen needs them on to show the buttons.
    center.playCommand.isEnabled = true
    center.pauseCommand.isEnabled = true
    center.togglePlayPauseCommand.isEnabled = true
    center.stopCommand.isEnabled = true
    center.skipForwardCommand.isEnabled = true
    center.skipForwardCommand.preferredIntervals = [NSNumber(value: 10)]
    center.skipBackwardCommand.isEnabled = true
    center.skipBackwardCommand.preferredIntervals = [NSNumber(value: 10)]
    // The hardware headset button is a play/pause toggle in every other browser.
    center.changePlaybackPositionCommand.isEnabled = false
  }
}
