import ExpoModulesCore
import Foundation

/// Unpacks a file another browser exported (Safari's export, a Takeout archive, a bookmarks file) into Bay's cache, so
/// JavaScript can read the parts it knows (src/import/exports.ts). Only bookmark pages and history files come out:
/// passwords, cards and everything else stay in the archive and are only named, so no secret reaches JavaScript.
public class BayImportModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BayImport")

    AsyncFunction("readExport") { (path: String) -> [String: Any] in
      try BayExport.read(path)
    }

    AsyncFunction("discardExport") {
      BayExport.discard()
    }

    // The phone's other browsers are found by URL scheme in JavaScript on iOS; this is Android's.
    AsyncFunction("installedBrowsers") { () -> [[String: Any]] in
      []
    }
  }
}
