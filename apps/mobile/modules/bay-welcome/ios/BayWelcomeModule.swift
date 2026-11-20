import ExpoModulesCore
import UIKit

/// The welcome's native parts (src/onboarding): the glass name the first page draws, and whether Bay is the default
/// browser, with the way to the setting that makes it so.
public class BayWelcomeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BayWelcome")

    /// "default", "not", or "unknown": iOS answers only from 18.2, only for a build that may be the default browser
    /// (BayCanBeDefaultBrowser, set with the managed entitlement) and only so often.
    Function("defaultBrowser") { () -> String in
      guard Self.canBeDefault else { return "unavailable" }
      if #available(iOS 18.2, *) {
        do {
          return try UIApplication.shared.isDefault(.webBrowser) ? "default" : "not"
        } catch {
          return "unknown"
        }
      }
      return "unknown"
    }

    /// iOS never asks in place: this opens Default Apps (18.3 and later), or Bay's own page in Settings before that.
    AsyncFunction("makeDefaultBrowser") { () async -> String in
      var target = UIApplication.openSettingsURLString
      if #available(iOS 18.3, *) { target = UIApplication.openDefaultApplicationsSettingsURLString }
      guard let url = URL(string: target) else { return "unavailable" }
      // `open` runs on the main actor itself.
      await UIApplication.shared.open(url)
      return "settings"
    }

    View(BayGlassNameView.self) {
      Prop("text") { (view: BayGlassNameView, text: String) in
        view.text = text
      }
    }
  }

  /// Set by the engine's config plugin when the build claims `com.apple.developer.web-browser`.
  static var canBeDefault: Bool {
    Bundle.main.object(forInfoDictionaryKey: "BayCanBeDefaultBrowser") as? Bool ?? false
  }
}
