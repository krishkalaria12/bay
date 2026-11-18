import BayCore
import UIKit

/// Whether Bay is the default browser, and the way to the setting that makes it so. iOS answers only from 18.2, only
/// for a build that claims Apple's managed browser entitlement (`BayCanBeDefaultBrowser`, set by Project.swift with
/// it), and only so often.
@MainActor
enum DefaultBrowserStatus {
  static var current: DefaultBrowser {
    guard canBeDefault else { return .unavailable }
    if #available(iOS 18.2, *) {
      do {
        return try UIApplication.shared.isDefault(.webBrowser) ? .default : .not
      } catch {
        return .unknown
      }
    }
    return .unknown
  }

  /// iOS never asks in place: this opens Default Apps (18.3 and later), or Bay's own page in Settings before that.
  static func openSetting() {
    var target = UIApplication.openSettingsURLString
    if #available(iOS 18.3, *) { target = UIApplication.openDefaultApplicationsSettingsURLString }
    guard let url = URL(string: target) else { return }
    UIApplication.shared.open(url)
  }

  private static var canBeDefault: Bool {
    Bundle.main.object(forInfoDictionaryKey: "BayCanBeDefaultBrowser") as? Bool ?? false
  }
}
