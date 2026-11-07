// Quick actions (B15): "New tab" and "Private tab" under Bay's icon, declared in Info.plist by the plugin and
// delivered here through the app delegate (the only path: shortcuts never cross the JS bridge). The type's last
// segment names the `bay://` command BrowserScreen answers as any incoming link (B9), so the app's own scheme
// carries it, including a cold start.
import ExpoModulesCore
import UIKit

@objc public final class BayShortcuts: BaseExpoAppDelegateSubscriber {
  private static let actions: [String: String] = [
    "new-tab": "bay://new-tab",
    "private-tab": "bay://private-tab",
    "search": "bay://search",
  ]

  @objc public override func application(
    _: UIApplication,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    completionHandler(Self.handle(shortcutItem))
  }

  private static func handle(_ shortcutItem: UIApplicationShortcutItem) -> Bool {
    guard
      let action = shortcutItem.type.split(separator: ".").last.flatMap(String.init),
      let address = actions[action],
      let url = URL(string: address)
    else {
      return false
    }

    // Opened, not opened-by: Bay's own URL handling (expo-linking, through the app delegate) carries the command
    // to JavaScript even on the cold start, as Bay's launch goes on.
    UIApplication.shared.open(url, options: [:], completionHandler: nil)

    return true
  }
}
