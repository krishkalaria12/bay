import ExpoModulesCore
import WebKit

public class BayEngineModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BayEngine")

    View(BayEngineView.self) {
      Events("onNavigationStateChange", "onNavigationError")

      AsyncFunction("load") { (view: BayEngineView, url: String) in
        try view.load(url)
      }
      AsyncFunction("goBack") { (view: BayEngineView) in _ = view.webView.goBack() }
      AsyncFunction("goForward") { (view: BayEngineView) in _ = view.webView.goForward() }
      AsyncFunction("reload") { (view: BayEngineView) in _ = view.webView.reload() }
      AsyncFunction("stop") { (view: BayEngineView) in view.webView.stopLoading() }
    }
  }
}

private class InvalidAddressException: Exception, @unchecked Sendable {
  override var reason: String { "Only HTTP and HTTPS addresses can be opened." }
}

class BayEngineView: ExpoView, WKNavigationDelegate, WKUIDelegate {
  let webView: WKWebView
  let onNavigationStateChange = EventDispatcher()
  let onNavigationError = EventDispatcher()
  private var observations: [NSKeyValueObservation] = []

  required init(appContext: AppContext? = nil) {
    webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    super.init(appContext: appContext)
    clipsToBounds = true
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    addSubview(webView)

    observations = [
      webView.observe(\.url, options: [.new]) { [weak self] _, _ in self?.emitState() },
      webView.observe(\.title, options: [.new]) { [weak self] _, _ in self?.emitState() },
      webView.observe(\.estimatedProgress, options: [.new]) { [weak self] _, _ in self?.emitState() },
      webView.observe(\.isLoading, options: [.new]) { [weak self] _, _ in self?.emitState() },
      webView.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in self?.emitState() },
      webView.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in self?.emitState() }
    ]
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    webView.frame = bounds
  }

  func load(_ address: String) throws {
    guard let url = URL(string: address), isWebURL(url) else { throw InvalidAddressException() }
    webView.load(URLRequest(url: url))
  }

  private func isWebURL(_ url: URL) -> Bool {
    ["http", "https"].contains(url.scheme?.lowercased() ?? "") && url.host?.isEmpty == false
  }

  private func emitState() {
    onNavigationStateChange([
      "url": webView.url?.absoluteString ?? "",
      "title": webView.title ?? "",
      "progress": webView.estimatedProgress,
      "isLoading": webView.isLoading,
      "canGoBack": webView.canGoBack,
      "canGoForward": webView.canGoForward
    ])
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    // External schemes require an explicit handoff UI in a later phase.
    decisionHandler(navigationAction.request.url.map(isWebURL) == true ? .allow : .cancel)
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if navigationAction.targetFrame == nil, let url = navigationAction.request.url, isWebURL(url) {
      webView.load(navigationAction.request)
    }
    return nil
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    emitError(error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    emitError(error)
  }

  private func emitError(_ error: Error) {
    let nativeError = error as NSError
    guard nativeError.code != NSURLErrorCancelled else { return }
    onNavigationError([
      "url": nativeError.userInfo[NSURLErrorFailingURLStringErrorKey] as? String ?? webView.url?.absoluteString ?? "",
      "code": "\(nativeError.domain):\(nativeError.code)",
      "message": nativeError.localizedDescription
    ])
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    onNavigationError(["url": webView.url?.absoluteString ?? "", "code": "renderer-terminated",
                       "message": "The page stopped responding. Reload to try again."])
  }
}
