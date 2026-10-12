import Foundation

public enum ExtensionsImport {
  public static func list(profile: URL, browser: BrowserDefinition) -> [ImportedExtension] {
    switch browser.family {
    case .chromium, .arc:
      return ChromiumExtensions.list(profile: profile)
    case .firefox:
      return FirefoxExtensions.list(profile: profile).map(FirefoxExtensionCounterparts.resolve)
    case .safari, .automation:
      return []
    }
  }
}
