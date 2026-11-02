
// Only the app's isolation and URL routing bridges are stubbed. The updater and Sparkle are real.
func NNIsolatedDataDirectory() -> String? { nil }
enum OpenURLInbox {
  static func receive(_ urls: [URL]) {}
}

func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
  guard condition() else { fatalError(message) }
}

_ = NSApplication.shared
let defaults = UserDefaults.standard
let originalChannel = defaults.object(forKey: "NNUpdateChannel")
defer {
  if let originalChannel {
    defaults.set(originalChannel, forKey: "NNUpdateChannel")
  } else {
    defaults.removeObject(forKey: "NNUpdateChannel")
  }
}

let updater = AppUpdater()
let controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: nil, userDriverDelegate: nil)
let item = SUAppcastItem(dictionary: [
  "sparkle:version": "42.2",
  "sparkle:shortVersionString": "1.5.3-nightly.2",
  "enclosure": ["url": "https://example.invalid/Bay.zip", "sparkle:version": "42.2"],
])!

updater.setChannel("nightly")
expect(updater.channel == "nightly", "An idle updater can switch channels")
updater.setChannel("invalid")
expect(updater.channel == "nightly", "Invalid channels are ignored")

var installed = false
_ = updater.updater(controller.updater, willInstallUpdateOnQuit: item, immediateInstallationBlock: { installed = true })
updater.setChannel("stable")
expect(updater.channel == "nightly", "A downloaded nightly prevents switching to Stable until installation finishes")
expect(updater.pending?["ready"] as? Bool == true, "A rejected channel change preserves the pending update")
updater.installPendingUpdate()
expect(installed, "The existing pending update can still install")

updater.updaterDidNotFindUpdate(controller.updater)
updater.setChannel("stable")
expect(updater.channel == "stable", "The channel can change after the pending update clears")
expect(updater.allowedChannels(for: controller.updater).isEmpty, "Stable excludes nightly appcast items")
updater.setChannel("nightly")
expect(updater.allowedChannels(for: controller.updater) == ["nightly"], "Nightly permits nightly appcast items")
print("PASS: channel selection, pending-install guard, and Sparkle channel filtering")
