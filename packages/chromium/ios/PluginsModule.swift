import AppKit
import ExpoModulesCore
import WebKit

// Plugins (apps/browser lib/plugins): folders with a manifest and a script, which bay-plugins (packages/rust/bay-plugins,
// through NNCorePlugins.mm) checks, copies into the plugins folder and serves. Windows and Linux: engine
// webui/plugins.cc.
//
// Each plugin runs in a WebKit page of its own at bay-plugin://<id>/__bay/host.html: out of process, in WebKit's
// sandboxed web content process, with a website data store of its own that never touches the disk. The page reads
// only its plugin's files, under bay-plugins' content security policy (no network: it fetches through Bay, which
// checks its manifest), and can't navigate away or open windows. It talks to the app through the "bay" message
// handler (onMessage) and window.__bayDeliver (post).

private let pluginScheme = "bay-plugin"

enum PluginFolder {
  /// Bay's plugins folder: beside the app's documents (BAY_DATA_DIR in tests).
  static func root() throws -> URL {
    let dir: URL
    if let custom = ProcessInfo.processInfo.environment["BAY_DATA_DIR"] {
      dir = URL(fileURLWithPath: custom, isDirectory: true)
    } else {
      let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      dir = base.appendingPathComponent(Bundle.main.bundleIdentifier ?? "Bay", isDirectory: true)
    }
    let root = dir.appendingPathComponent("Plugins", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }
}

/// Serves one plugin's files to its own page, and nothing else.
private final class PluginFiles: NSObject, WKURLSchemeHandler {
  let id: String
  init(id: String) { self.id = id }

  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url, url.scheme == pluginScheme, url.host == id,
          let root = try? PluginFolder.root().path,
          let file = NNCorePlugins.file(path: url.path, id: id, root: root),
          let data = file["data"] as? Data, let mime = file["mime"] as? String,
          let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": mime,
            "Content-Length": String(data.count),
            "Content-Security-Policy": NNCorePlugins.contentSecurityPolicy(),
            "Cache-Control": "no-store",
          ]) else {
      task.didFailWithError(URLError(.fileDoesNotExist))
      return
    }
    task.didReceive(response)
    task.didReceive(data)
    task.didFinish()
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

private final class PluginPage: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
  let id: String
  let web: WKWebView
  weak var module: PluginsModule?

  init(id: String, module: PluginsModule) {
    self.id = id
    self.module = module
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.setURLSchemeHandler(PluginFiles(id: id), forURLScheme: pluginScheme)
    config.preferences.javaScriptCanOpenWindowsAutomatically = false
    config.mediaTypesRequiringUserActionForPlayback = .all
    config.suppressesIncrementalRendering = true
    web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1, height: 1), configuration: config)
    super.init()
    // The handler holds this page weakly through the module; stop() removes it.
    config.userContentController.add(self, name: "bay")
    web.navigationDelegate = self
    web.uiDelegate = self
  }

  func load() {
    guard let url = URL(string: "\(pluginScheme)://\(id)/__bay/host.html") else { return }
    web.load(URLRequest(url: url))
  }

  func stop() {
    web.configuration.userContentController.removeScriptMessageHandler(forName: "bay")
    web.stopLoading()
    web.navigationDelegate = nil
    web.uiDelegate = nil
    // A blank page ends the plugin's script and frees its content process.
    web.loadHTMLString("", baseURL: nil)
  }

  func post(_ message: String) {
    web.callAsyncJavaScript("window.__bayDeliver && window.__bayDeliver(message)", arguments: ["message": message], in: nil, in: .page) { _ in }
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, let text = message.body as? String, text.utf8.count <= 8 * 1024 * 1024 else { return }
    module?.sendEvent("onMessage", ["id": id, "message": text])
  }

  // Its own files only: no other page, no link opened elsewhere.
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    let url = action.request.url
    decisionHandler(url?.scheme == pluginScheme && url?.host == id ? .allow : .cancel)
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
               windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    module?.pageEnded(id, reason: "crashed")
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    module?.pageEnded(id, reason: "didn't start")
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    module?.pageEnded(id, reason: "didn't start")
  }
}

public class PluginsModule: Module {
  private var pages: [String: PluginPage] = [:]
  private static let disk = DispatchQueue(label: "bay.plugins", qos: .userInitiated)

  fileprivate func pageEnded(_ id: String, reason: String) {
    guard let page = pages.removeValue(forKey: id) else { return }
    page.stop()
    sendEvent("onExit", ["id": id, "reason": reason])
  }

  private static func validId(_ id: String) -> Bool {
    (2...40).contains(id.count) && id.first?.isLowercase == true && !id.hasSuffix("-")
      && id.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
  }

  public func definition() -> ModuleDefinition {
    Name("BayPlugins")
    Events("onMessage", "onExit")

    OnDestroy {
      for page in self.pages.values { page.stop() }
      self.pages.removeAll()
    }

    AsyncFunction("list") { () -> String in
      NNCorePlugins.list(root: try PluginFolder.root().path)
    }.runOnQueue(Self.disk)

    AsyncFunction("install") { (promise: Promise) in
      let panel = NSOpenPanel()
      panel.canChooseFiles = false
      panel.canChooseDirectories = true
      panel.allowsMultipleSelection = false
      panel.message = "Choose a plugin's folder: the one with its manifest.json. Bay keeps a copy of it."
      panel.prompt = "Add Plugin"
      panel.begin { result in
        guard result == .OK, let source = panel.url else { return promise.resolve(nil) }
        Self.disk.async {
          do { promise.resolve(NNCorePlugins.install(source: source.path, root: try PluginFolder.root().path)) }
          catch { promise.reject("ERR_PLUGINS", error.localizedDescription) }
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("remove") { (id: String) -> Bool in
      guard Self.validId(id) else { return false }
      return NNCorePlugins.remove(id: id, root: try PluginFolder.root().path)
    }.runOnQueue(Self.disk)

    AsyncFunction("reveal") {
      NSWorkspace.shared.open(try PluginFolder.root())
    }.runOnQueue(.main)

    AsyncFunction("start") { (id: String) -> Bool in
      guard Self.validId(id) else { return false }
      self.pages.removeValue(forKey: id)?.stop()
      let page = PluginPage(id: id, module: self)
      self.pages[id] = page
      page.load()
      return true
    }.runOnQueue(.main)

    AsyncFunction("stop") { (id: String) in
      self.pages.removeValue(forKey: id)?.stop()
    }.runOnQueue(.main)

    AsyncFunction("post") { (id: String, message: String) in
      self.pages[id]?.post(message)
    }.runOnQueue(.main)
  }
}
