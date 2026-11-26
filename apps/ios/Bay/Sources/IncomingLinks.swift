import UIKit

/// Links from other apps (B9, B14, B15): pages opened in Bay, the share extension's `bay://share?url=…`, and the
/// `bay://` commands that widgets and quick actions send. One that arrives before the browser can take it (as Bay
/// starts, or under the welcome) waits until it can; only the newest one waits. What a link means is the browser's to
/// read (`BrowserModel.openIncoming`).
@MainActor
final class IncomingLinks {
  static let shared = IncomingLinks()

  private var waiting: String?

  /// Takes each link once the browser shows, starting with the one that waited; nil while it can't.
  var receiver: ((String) -> Void)? {
    didSet { handOver() }
  }

  func arrive(_ url: String) {
    waiting = url
    handOver()
  }

  /// A quick action, as the `bay://` command it stands for. False for one Bay doesn't know.
  @discardableResult
  func arrive(_ shortcut: UIApplicationShortcutItem) -> Bool {
    // Types are the bundle id with the command after it (`….new-tab`), as Project.swift declares them.
    guard let command = shortcut.type.split(separator: ".").last, ["new-tab", "private-tab"].contains(command) else {
      return false
    }
    arrive("bay://\(command)")
    return true
  }

  private func handOver() {
    guard let receiver, let url = waiting else { return }
    waiting = nil
    receiver(url)
  }
}

/// Gives Bay's scene a delegate of its own, for quick actions: SwiftUI reports links but not shortcuts.
final class AppDelegate: NSObject, UIApplicationDelegate {
  func application(
    _ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: nil, sessionRole: session.role)
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }
}

/// Hands quick actions to `IncomingLinks`: the one that launched Bay, and those chosen while it runs.
final class SceneDelegate: NSObject, UIWindowSceneDelegate {
  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    if let shortcut = connectionOptions.shortcutItem { IncomingLinks.shared.arrive(shortcut) }
  }

  func windowScene(
    _ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    completionHandler(IncomingLinks.shared.arrive(shortcutItem))
  }
}
