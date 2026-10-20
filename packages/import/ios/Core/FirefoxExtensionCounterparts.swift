import Foundation

// Publisher-verified identifiers only. Display names never determine which package gets installed.
enum FirefoxExtensionCounterparts {
  static let identifiers: [String: String] = [
    // https://github.com/darkreader/darkreader/blob/b4fb44b3aaa2c28353cf9d649cd8f10c1fa95f58/src/manifest-firefox.json
    // The same publisher's README links the Chromium listing.
    "addon@darkreader.org": "eimadpbcbfnmbkopoojfekhnkhdbieeh",
    // https://github.com/EFForg/privacybadger/blob/f5c476523ffa44848e8f1808f8a1b4eec3432aef/src/js/constants.js
    // Firefox manifest + release-utils/firefox-release.sh define these two official addon IDs.
    "jid1-MnnxcxisBPnSXQ@jetpack": "pkehgijcmpdhfbdbbnkijodmdjhbjlgp",
    "jid1-MnnxcxisBPnSXQ-eff@jetpack": "pkehgijcmpdhfbdbbnkijodmdjhbjlgp",
    // https://github.com/bitwarden/clients/blob/df9641824436b65207f393d35b8d07225129797b/apps/browser/src/manifest.v3.json
    // apps/browser/README.md links the Chromium listing.
    "{446900e4-71c2-419f-a6a7-df9c091e268b}": "nngceckbapebfimnlniiiahkandclblb",
  ]

  static func resolve(_ original: ImportedExtension) -> ImportedExtension {
    guard let id = identifiers[original.id] else { return original }
    var extensionInfo = original
    extensionInfo.destinationId = id
    extensionInfo.webStoreUrl = "https://chromewebstore.google.com/detail/\(id)"
    extensionInfo.compatibility = ImportedExtensionCompatibility(status: "compatible")
    extensionInfo.updateMode = "store"
    extensionInfo.warnings = ["Installed the publisher's Chromium version. Firefox extension settings aren't migrated."]
    return extensionInfo
  }
}
