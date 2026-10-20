import Foundation

/// Conservative translation of APIs whose Chromium behavior is equivalent. This is static screening,
/// not a promise that arbitrary JavaScript or an extension's external services work after conversion.
enum FirefoxExtensionAdapter {
  private static let shimName = "bay-firefox-compat.js"
  private static let workerName = "bay-firefox-background.js"
  private static let permissions: Set<String> = [
    "activeTab", "alarms", "bookmarks", "browsingData", "clipboardRead", "clipboardWrite",
    "contextMenus", "cookies", "debugger", "declarativeNetRequest", "declarativeNetRequestFeedback",
    "declarativeNetRequestWithHostAccess", "downloads", "downloads.open", "fontSettings", "geolocation",
    "history", "idle", "management", "nativeMessaging", "notifications", "pageCapture", "privacy",
    "scripting", "search", "sessions", "storage", "tabCapture", "tabs", "topSites", "unlimitedStorage",
    "webNavigation", "webRequest"
  ]
  private static let unsupportedAPIs = [
    "contextualIdentities", "pageAction", "proxy", "browserSettings", "privacy.network", "sidebarAction", "userScripts",
    "webRequest.filterResponseData", "webRequest.getSecurityInfo", "tabs.hide", "tabs.show", "tabs.getPanel",
    "tabs.moveInSuccession", "tabs.captureTab", "tabs.executeScript", "tabs.insertCSS", "tabs.removeCSS",
    "runtime.getFrameId", "runtime.onUserScriptConnect", "runtime.onUserScriptMessage",
    "runtime.connectNative", "runtime.sendNativeMessage", "menus.overrideContext", "menus.getTargetElement",
    "commands.update", "commands.reset", "sessions.setTabValue", "sessions.getTabValue",
    "sessions.removeTabValue", "sessions.setWindowValue", "sessions.getWindowValue", "sessions.removeWindowValue",
    "extension.getBackgroundPage", "runtime.getBackgroundPage", "extension.lastError", "extension.onRequest",
    "extension.onRequestExternal", "extension.sendRequest", "extension.getExtensionTabs", "tabs.getAllInWindow",
    "tabs.getSelected", "tabs.sendRequest", "tabs.onActiveChanged", "tabs.onHighlightChanged", "tabs.onSelectionChanged"
  ]

  static func convert(files input: [String: Data], id: String) throws -> [String: Data] {
    guard let data = input["manifest.json"],
          var manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let version = manifest["manifest_version"] as? Int, [2, 3].contains(version),
          let name = manifest["name"] as? String, !name.isEmpty,
          let release = manifest["version"] as? String, !release.isEmpty else {
      throw FirefoxExtensions.PreparationError.unsupported(["The Firefox add-on manifest is invalid or unsupported."])
    }
    var reasons: [String] = []
    let declaredID = ((manifest["browser_specific_settings"] ?? manifest["applications"]) as? [String: Any])?["gecko"] as? [String: Any]
    if let declared = declaredID?["id"] as? String, declared != id {
      reasons.append("The Firefox add-on package identity does not match its profile entry.")
    }
    for key in ["sidebar_action", "page_action", "protocol_handlers", "user_scripts", "experiment_apis", "theme", "chrome_settings_overrides"] {
      if manifest[key] != nil { reasons.append("Firefox manifest field \(key) requires browser support that is not available.") }
    }
    for key in ["permissions", "optional_permissions"] {
      guard manifest[key] == nil || manifest[key] is [String] else {
        reasons.append("Firefox \(key) is not a list of strings."); continue
      }
      let values = manifest[key] as? [String] ?? []
      var regular: [String] = []
      var hosts = manifest[key == "permissions" ? "host_permissions" : "optional_host_permissions"] as? [String] ?? []
      for permission in values {
        if isHost(permission) { hosts.append(permission) }
        else if permission == "menus" { regular.append("contextMenus") }
        else if permissions.contains(permission) { regular.append(permission) }
        else { reasons.append("Firefox permission \(permission) is unsupported and cannot be removed safely.") }
      }
      if manifest[key] != nil { manifest[key] = regular }
      if !hosts.isEmpty { manifest[key == "permissions" ? "host_permissions" : "optional_host_permissions"] = Array(Set(hosts)).sorted() }
    }
    if (manifest["permissions"] as? [String] ?? []).contains("nativeMessaging") {
      reasons.append("Firefox native messaging hosts require a separate Chromium host installation.")
    }
    if let resources = manifest["web_accessible_resources"] as? [String] {
      manifest["web_accessible_resources"] = [["resources": resources, "matches": ["<all_urls>"]]]
    }
    if let csp = manifest["content_security_policy"] as? String {
      manifest["content_security_policy"] = ["extension_pages": csp]
    }
    if let csp = manifest["content_security_policy"] as? [String: Any] {
      let policy = csp["extension_pages"] as? String ?? ""
      // Chrome MV3 disallows remote scripts, unsafe-eval and arbitrary script hashes. Refuse rather
      // than quietly weaken the policy or change behavior of code that needs those capabilities.
      if policy.contains("'unsafe-eval'") || policy.contains("'unsafe-inline'") || policy.contains("http:") ||
          policy.contains("https:") || policy.contains("'sha") || policy.contains("'nonce") {
        reasons.append("The Firefox extension CSP requires script execution forbidden by Chromium Manifest V3.")
      }
    }
    if version == 2, manifest["browser_action"] != nil, manifest["page_action"] != nil {
      reasons.append("Separate Firefox browser_action and page_action cannot both map to one Chromium action.")
    }
    if manifest["action"] == nil { manifest["action"] = manifest["browser_action"] ?? manifest["page_action"] }
    manifest.removeValue(forKey: "browser_action")
    manifest.removeValue(forKey: "page_action")
    if var options = manifest["options_ui"] as? [String: Any] {
      options.removeValue(forKey: "browser_style")
      manifest["options_ui"] = options
    }
    if var action = manifest["action"] as? [String: Any] {
      action.removeValue(forKey: "browser_style")
      manifest["action"] = action
    }
    var files = input
    if files[shimName] != nil || files[workerName] != nil { reasons.append("The add-on uses reserved compatibility script names.") }
    for (path, contents) in input where ["js", "mjs", "html", "htm"].contains((path as NSString).pathExtension.lowercased()) {
      guard let script = String(data: contents, encoding: .utf8) else {
        reasons.append("Add-on script \(path) is not UTF-8."); continue
      }
      for api in unsupportedAPIs {
        let segments = api.split(separator: ".").map { NSRegularExpression.escapedPattern(for: String($0)) }
        let pattern = #"\b(?:browser|chrome)\s*\.\s*"# + segments.joined(separator: #"\s*\.\s*"#) + #"\b"#
        if script.range(of: pattern, options: .regularExpression) != nil {
          reasons.append("Firefox API \(api) in \(path) is unsupported or differs from Chromium.")
        }
      }
      if script.range(of: #"\b(?:browser|chrome)\s*\["#, options: .regularExpression) != nil ||
          script.range(of: #"\b(?:eval\s*\(|new\s+Function\s*\()"#, options: .regularExpression) != nil {
        reasons.append("Dynamic API access or generated code in \(path) cannot be checked by the compatibility adapter.")
      }
      if script.contains("moz-extension://") || script.contains("cookieStoreId") || script.contains("firstPartyDomain") || script.contains("incognito: \"not_allowed\"") {
        reasons.append("Firefox-specific origins or container semantics in \(path) require a manual port.")
      }
    }
    let shim = """
    // Firefox-to-Chromium equivalents. Missing APIs are not replaced with no-op implementations.
    (() => {
      for (const api of [globalThis.browser, globalThis.chrome]) {
        if (!api || !api.runtime) continue;
        if (typeof api.runtime.getBrowserInfo !== 'function') {
          api.runtime.getBrowserInfo = () => Promise.resolve({name: 'Bay', vendor: 'Bay', version: (globalThis.navigator?.userAgent.match(/Chrome\\/(\\S+)/)?.[1] || 'unknown'), buildID: 'firefox-compat'});
        }
        if (!api.menus && api.contextMenus) api.menus = api.contextMenus;
        if (!api.browserAction && api.action) api.browserAction = api.action;
        if (!api.extension) api.extension = {};
        if (typeof api.extension.getURL !== 'function' && typeof api.runtime.getURL === 'function') {
          api.extension.getURL = api.runtime.getURL.bind(api.runtime);
        }
      }
    })();
    """
    files[shimName] = Data(shim.utf8)
    if let background = manifest["background"] as? [String: Any] {
      if background["page"] != nil || version == 2 && background["persistent"] as? Bool != false {
        reasons.append("Firefox persistent or HTML background pages need a manual service worker port.")
      }
      let scripts = background["scripts"] as? [String] ?? []
      let worker = background["service_worker"] as? String
      if scripts.isEmpty && worker == nil { reasons.append("The Firefox background definition has no supported scripts.") }
      if !scripts.isEmpty && worker != nil { reasons.append("The Firefox background mixes scripts with a service worker.") }
      let base = worker.map { ($0 as NSString).deletingLastPathComponent } ?? ""
      let checkedScripts = backgroundDependencies(scripts + (worker.map { [$0] } ?? []), base: base, files: input, reasons: &reasons)
      for script in checkedScripts {
        guard FirefoxExtensions.safePath(script), let data = input[script], let code = String(data: data, encoding: .utf8) else {
          reasons.append("Firefox background script \(script) is missing or unsafe."); continue
        }
        if code.range(of: #"\b(?:window|document|localStorage|sessionStorage|XMLHttpRequest|DOMParser|alert|confirm|prompt)\b"#, options: .regularExpression) != nil {
          reasons.append("Firefox background script \(script) uses DOM or persistent page APIs unavailable in service workers.")
        }
      }
      if background["type"] as? String == "module" {
        reasons.append("Firefox module backgrounds require a manual service worker port.")
      }
      if let worker {
        // Prefix in place to preserve URLs resolved relative to the original worker's directory.
        if let data = input[worker] { files[worker] = Data(("importScripts(" + jsonString(relativeShim(from: worker)) + ");\n").utf8) + data }
        manifest["background"] = ["service_worker": worker]
      } else {
        files[workerName] = Data(("importScripts(" + ([shimName] + scripts).map(jsonString).joined(separator: ",") + ");\n").utf8)
        manifest["background"] = ["service_worker": workerName]
      }
    }
    if let scripts = manifest["content_scripts"] as? [[String: Any]] {
      manifest["content_scripts"] = scripts.map { entry -> [String: Any] in
        var copy = entry
        if let js = entry["js"] as? [String], !js.isEmpty { copy["js"] = [shimName] + js }
        return copy
      }
    }
    // Extension pages need the same shim before their own scripts. It is a packaged external
    // script, so it works with Chrome's default MV3 CSP without allowing inline execution.
    var entryPages = Set((manifest["chrome_url_overrides"] as? [String: String] ?? [:]).values)
    for page in [manifest["options_page"] as? String, manifest["devtools_page"] as? String,
                 (manifest["options_ui"] as? [String: Any])?["page"] as? String,
                 (manifest["action"] as? [String: Any])?["default_popup"] as? String].compactMap({ $0 }) {
      entryPages.insert(page)
    }
    for (path, data) in input where ["html", "htm"].contains((path as NSString).pathExtension.lowercased()) {
      if var html = String(data: data, encoding: .utf8) {
        let tag = "<script src=\"" + relativeShim(from: path) + "\"></script>"
        if let head = html.range(of: #"<head(?:\s[^>]*)?>"#, options: [.regularExpression, .caseInsensitive]) {
          html.insert(contentsOf: tag, at: head.upperBound)
        } else if entryPages.contains(path) {
          reasons.append("Extension page \(path) has no head element for safe compatibility script injection.")
        }
        files[path] = Data(html.utf8)
      }
    }
    guard reasons.isEmpty else { throw FirefoxExtensions.PreparationError.unsupported(Array(Set(reasons)).sorted()) }
    manifest["manifest_version"] = 3
    manifest["key"] = FirefoxExtensions.identityKey(id).base64EncodedString()
    for key in ["browser_specific_settings", "applications", "update_url", "offline_enabled"] { manifest.removeValue(forKey: key) }
    files["manifest.json"] = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
    return files
  }

  private static func backgroundDependencies(_ roots: [String], base: String, files: [String: Data], reasons: inout [String]) -> [String] {
    var pending = roots
    var checked: Set<String> = []
    let calls = try! NSRegularExpression(pattern: #"\bimportScripts\s*\(([^)]*)\)"#)
    let literal = try! NSRegularExpression(pattern: #"^\s*[\"']([^\"'\\]+)[\"']\s*$"#)
    while let path = pending.popLast() {
      guard checked.insert(path).inserted, let data = files[path], let script = String(data: data, encoding: .utf8) else { continue }
      for call in calls.matches(in: script, range: NSRange(script.startIndex..., in: script)) {
        guard let arguments = Range(call.range(at: 1), in: script) else { continue }
        for argument in script[arguments].split(separator: ",", omittingEmptySubsequences: false) {
          let text = String(argument)
          guard let match = literal.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
                let valueRange = Range(match.range(at: 1), in: text) else {
            reasons.append("Dynamic background script imports in \(path) cannot be checked."); continue
          }
          let imported = String(text[valueRange])
          guard !imported.contains(":"), !imported.contains("?"), !imported.contains("#") else {
            reasons.append("External or dynamic background script import \(imported) is unsupported."); continue
          }
          let resolved = (imported.hasPrefix("/") ? URL(fileURLWithPath: imported) :
            URL(fileURLWithPath: "/" + base, isDirectory: true).appendingPathComponent(imported)).standardizedFileURL.path
          let name = String(resolved.dropFirst())
          guard FirefoxExtensions.safePath(name), files[name] != nil else {
            reasons.append("Background dependency \(imported) in \(path) is missing or unsafe."); continue
          }
          pending.append(name)
        }
      }
    }
    return checked.sorted()
  }

  private static func isHost(_ permission: String) -> Bool { permission == "<all_urls>" || permission.contains("://") }
  private static func jsonString(_ value: String) -> String {
    String(data: try! JSONSerialization.data(withJSONObject: [value]), encoding: .utf8)!.dropFirst().dropLast().description
  }
  private static func relativeShim(from path: String) -> String {
    String(repeating: "../", count: path.split(separator: "/").count - 1) + shimName
  }
}
