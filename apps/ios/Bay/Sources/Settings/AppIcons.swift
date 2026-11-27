import UIKit

/// An icon Bay can wear on the home screen, the same set as the desktop's: `name` is the alternate icon's name in the
/// asset catalog (nil is the bundle's own icon, Paper).
struct AppIcon: Equatable {
  let name: String?
  /// The icon's name in the strings (`settings.appIcons.*`).
  let label: String
  /// Its preview in the asset catalog.
  let preview: String

  static let all: [AppIcon] = [
    AppIcon(name: nil, label: "settings.appIcons.paper", preview: "AppIconPreviews/Paper"),
    AppIcon(name: "Navy", label: "settings.appIcons.navy", preview: "AppIconPreviews/Navy"),
    AppIcon(name: "Coral", label: "settings.appIcons.coral", preview: "AppIconPreviews/Coral"),
    AppIcon(name: "Noir", label: "settings.appIcons.noir", preview: "AppIconPreviews/Noir"),
    AppIcon(name: "Cobalt", label: "settings.appIcons.cobalt", preview: "AppIconPreviews/Cobalt"),
    AppIcon(name: "Bridge", label: "settings.appIcons.bridge", preview: "AppIconPreviews/Bridge"),
  ]

  /// The id its picker tile goes by.
  var testID: String { "settings-app-icon-\((name ?? "default").lowercased())" }

  /// Whether this phone lets Bay change its icon.
  @MainActor static var supported: Bool { UIApplication.shared.supportsAlternateIcons }

  /// The icon on the home screen now; an alternate this build doesn't know reads as the default.
  @MainActor static var current: AppIcon {
    let name = UIApplication.shared.alternateIconName
    return all.first { $0.name == name } ?? all[0]
  }

  /// Puts the icon on the home screen; iOS confirms with its own alert, and can refuse (another change still going).
  @MainActor func apply() async throws {
    try await UIApplication.shared.setAlternateIconName(name)
  }
}
