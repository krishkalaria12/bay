import ExpoModulesCore
import UIKit
import WebKit

private final class InvalidAddressException: Exception, @unchecked Sendable {
  override var reason: String { "Only HTTP and HTTPS addresses can be opened." }
}

class BayEngineView: ExpoView, WKNavigationDelegate, WKUIDelegate, UIScrollViewDelegate {
  private(set) var webView: WKWebView
  let onNavigationStateChange = EventDispatcher()
  let onNavigationError = EventDispatcher()
  let onScroll = EventDispatcher()
  let onLinkPress = EventDispatcher()
  let onPageMessage = EventDispatcher()
  let onPageRequest = EventDispatcher()
  // Declared for the shared API (A2); WebKit presents element fullscreen itself and never emits it.
  let onFullscreenChange = EventDispatcher()
  private lazy var messageProxy = BayPageMessageProxy(view: self)
  private let refreshControl = UIRefreshControl()
  /// When the current pull to refresh started: the spinner stays at least briefly, so a cached reload doesn't flash it.
  private var refreshStartedAt: CFTimeInterval = 0
  private var observations: [NSKeyValueObservation] = []
  private var lastScrollOffset: CGFloat = 0
  private var lastScrollEmission: CFTimeInterval = 0
  private var pendingScroll: DispatchWorkItem?
  private var snapshotURL: URL?
  private var startedLoading = false
  private var pendingInitialURL: String?
  /// The tab's first navigation became a download, so it has no page; reported as `blank` while that's still so.
  private var firstNavigationBecameDownload = false
  /// Hosts this view moved from HTTP to HTTPS, with when; an HTTPS page that sends the view straight back keeps HTTP.
  private var upgradedHosts: [String: Date] = [:]

  /// Private pages use the shared non-persistent store. Set before the first load (React sets props on creation).
  var isPrivate = false {
    didSet {
      if isPrivate != oldValue && !startedLoading { replaceWebView() }
    }
  }

  /// Hidden tabs stay mounted; keep them out of VoiceOver.
  var isActive = true {
    didSet { webView.accessibilityElementsHidden = !isActive }
  }

  /// Hidden tabs that aren't playing media are hidden from WebKit too, which then throttles their timers and animations.
  var isSuspended = false {
    didSet { webView.isHidden = isSuspended }
  }

  var pullToRefreshEnabled = true {
    didSet {
      webView.scrollView.refreshControl = pullToRefreshEnabled ? refreshControl : nil
      if !pullToRefreshEnabled { refreshControl.endRefreshing() }
    }
  }

  required init(appContext: AppContext? = nil) {
    webView = Self.makeWebView(isPrivate: false)
    super.init(appContext: appContext)
    clipsToBounds = true
    refreshControl.addTarget(self, action: #selector(refresh), for: .valueChanged)
    setUpWebView()
  }

  private static func makeWebView(isPrivate: Bool) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    if isPrivate { configuration.websiteDataStore = BayPrivateBrowsing.dataStore() }
    // Video plays in the page when it asks to (playsinline), as in Safari.
    configuration.allowsInlineMediaPlayback = true
    // Google won't sign anyone in from what it can tell is an app's embedded web view ("This browser or app may not be
    // secure", OAuth's disallowed_useragent): WKWebView's user agent ends at "Mobile/15E148", without Safari's
    // "Version/… Safari/…" tokens. Bay is a browser, so it presents as Safari does (Android drops `; wv` likewise).
    configuration.applicationNameForUserAgent = safariUserAgentSuffix
    return WKWebView(frame: .zero, configuration: configuration)
  }

  /// "Version/26.0 Mobile/15E148 Safari/604.1", with this iOS's major and minor version, as Safari sends.
  private static let safariUserAgentSuffix: String = {
    let parts = UIDevice.current.systemVersion.split(separator: ".")
    let version = "\(parts.first ?? "26").\(parts.count > 1 ? parts[1] : "0")"
    return "Version/\(version) Mobile/15E148 Safari/604.1"
  }()

  /// The page's scriptlets (`##+js`), set before WebKit creates its document so they run in the page's own world ahead
  /// of its scripts. Replaced on every main-frame navigation.
  private func applyScriptlets(for url: URL) {
    let controller = webView.configuration.userContentController
    controller.removeAllUserScripts()
    guard let script = BayContentBlocker.shared.scriptlets(for: url) else { return }
    NSLog("BayContentBlocker: scriptlets for %@: %d chars", url.host ?? "", script.count)
    controller.addUserScript(WKUserScript(source: "try{\(script)}catch(e){}", injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
  }

  private func setUpWebView() {
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = true
    // Sites' custom players call `element.requestFullscreen()`, which WebKit only honours when this is on
    // (native `<video>` fullscreen already works with `allowsInlineMediaPlayback`). Android gets the same
    // behaviour from `onShowCustomView` in its WebChromeClient.
    webView.isElementFullscreenEnabled = true
    webView.accessibilityElementsHidden = !isActive
    webView.isHidden = isSuspended
    webView.scrollView.delegate = self
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.scrollView.alwaysBounceVertical = true
    webView.scrollView.refreshControl = pullToRefreshEnabled ? refreshControl : nil
    // Page scripts run in this isolated world (see evaluate), so only they can post to the app.
    webView.configuration.userContentController.add(messageProxy, contentWorld: .defaultClient, name: "bay")
    addSubview(webView)
    observations = [
      webView.observe(\.url, options: [.new]) { [weak self] _, _ in self?.emitState() },
      webView.observe(\.title, options: [.new]) { [weak self] _, _ in self?.emitState() },
      webView.observe(\.estimatedProgress, options: [.new]) { [weak self] _, _ in self?.emitState() },
      webView.observe(\.isLoading, options: [.new]) { [weak self] _, _ in self?.emitState() },
      webView.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in self?.emitState() },
      webView.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in self?.emitState() }
    ]
    BayContentBlocker.shared.register(self)
  }

  private func replaceWebView() {
    cancelPageRequests()
    observations = []
    webView.configuration.userContentController.removeScriptMessageHandler(forName: "bay", contentWorld: .defaultClient)
    webView.navigationDelegate = nil
    webView.uiDelegate = nil
    webView.scrollView.delegate = nil
    webView.removeFromSuperview()
    webView = Self.makeWebView(isPrivate: isPrivate)
    setUpWebView()
    setNeedsLayout()
  }

  func applyContentRules(for url: URL?) {
    let controller = webView.configuration.userContentController
    controller.removeAllContentRuleLists()
    for list in BayContentBlocker.shared.rules(for: url) { controller.add(list) }
  }

  deinit {
    pendingScroll?.cancel()
    cancelPageRequests()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    webView.frame = bounds
  }

  func load(_ address: String) throws {
    guard let url = URL(string: address), isWebURL(url) else { throw InvalidAddressException() }
    cancelPageRequests()
    startedLoading = true
    webView.load(URLRequest(url: url))
  }

  /// Loads once, when the view is created, unless a navigation already started. Invalid addresses are ignored.
  /// Waits a turn of the run loop so the other initial props (`private` in particular) apply first.
  func loadInitial(_ address: String?) {
    guard !startedLoading, let address, !address.isEmpty else { return }
    pendingInitialURL = address
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.startedLoading, let address = self.pendingInitialURL else { return }
      self.pendingInitialURL = nil
      try? self.load(address)
    }
  }

  /// Runs a page script in the isolated world and resolves with its result as JSON text.
  func evaluate(_ script: String, _ promise: Promise) {
    let body = """
      const post = (message) => window.webkit.messageHandlers.bay.postMessage(JSON.stringify(message));
      const value = await (async () => {
      \(script)
      })();
      return JSON.stringify(value === undefined ? null : value);
      """
    webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .defaultClient) { result in
      switch result {
      case .success(let value): promise.resolve(value as? String ?? "null")
      case .failure(let error): promise.reject("E_PAGE_SCRIPT", error.localizedDescription)
      }
    }
  }

  fileprivate func receive(_ message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, let text = message.body as? String else { return }
    onPageMessage(["message": text])
  }

  func stop() {
    webView.stopLoading()
    refreshControl.endRefreshing()
  }

  @objc private func refresh() {
    guard pullToRefreshEnabled, webView.url != nil else {
      refreshControl.endRefreshing()
      return
    }
    // A tick as the pull crosses the trigger point, as on Android.
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    refreshStartedAt = CACurrentMediaTime()
    webView.reload()
  }

  /// Ends a pull to refresh once the reload has run, after the spinner has shown for at least 0.45 s (Android's minimum).
  private func endRefreshingWhenLoaded() {
    guard refreshControl.isRefreshing, !webView.isLoading else { return }
    let remaining = 0.45 - (CACurrentMediaTime() - refreshStartedAt)
    guard remaining > 0 else {
      refreshControl.endRefreshing()
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + remaining) { [weak self] in
      // The reload may have started in the meantime; its own finish ends the spinner then.
      guard let self, !self.webView.isLoading else { return }
      self.refreshControl.endRefreshing()
    }
  }

  /// WebKit draws on the main thread; the resize, JPEG encoding and file write run in the background. A suspended
  /// (hidden) page resolves nil: WebKit may not have drawn it.
  func snapshot(_ promise: Promise) {    guard !isSuspended, bounds.width > 0, bounds.height > 0, webView.url != nil else {
      promise.resolve(nil as String?)
      return
    }
    let configuration = WKSnapshotConfiguration()
    configuration.rect = webView.bounds
    webView.takeSnapshot(with: configuration) { [weak self] image, error in
      if let error { promise.reject(error); return }
      guard let image, image.size.width > 0, image.size.height > 0, let directory = BayEngineSnapshots.directory else {
        promise.resolve(nil as String?)
        return
      }
      DispatchQueue.global(qos: .utility).async {
        let width = min(image.size.width, 640)
        let size = CGSize(width: width, height: image.size.height * width / image.size.width)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let thumbnail = UIGraphicsImageRenderer(size: size, format: format).image { _ in
          image.draw(in: CGRect(origin: .zero, size: size))
        }
        guard let data = thumbnail.jpegData(compressionQuality: 0.75) else {
          promise.resolve(nil as String?)
          return
        }
        let url = directory.appendingPathComponent("\(UUID().uuidString).jpg")
        do {
          try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
          try data.write(to: url, options: .atomic)
        } catch {
          promise.reject(error)
          return
        }
        // snapshotURL is only read and swapped on the main thread, so overlapping snapshots can't race.
        DispatchQueue.main.async {
          if let previous = self?.snapshotURL { try? FileManager.default.removeItem(at: previous) }
          self?.snapshotURL = url
          promise.resolve(url.absoluteString)
        }
      }
    }
  }

  private func isWebURL(_ url: URL) -> Bool {
    ["http", "https"].contains(url.scheme?.lowercased() ?? "") && url.host?.isEmpty == false
  }

  /// A scheme that belongs to another app: tel:, mailto:, maps, an app's own scheme. Web and data schemes stay here.
  private func isExternalURL(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased(), !scheme.isEmpty else { return false }
    let inPage: Set<String> = ["http", "https", "about", "javascript", "data", "blob", "file", "ws", "wss", "chrome", "chrome-extension"]
    return !inPage.contains(scheme) && scheme.range(of: "^[a-z][a-z0-9+.-]*$", options: .regularExpression) != nil
  }

  /// Asks whether to hand a link to another app, then cancels the page's navigation either way.
  private func requestExternal(_ url: URL) {
    let id = UUID().uuidString
    pendingPageRequests[id] = { accepted, _ in
      guard accepted else { return }
      DispatchQueue.main.async { UIApplication.shared.open(url) }
    }
    emitPageRequest(id: id, kind: "external", message: "", defaultValue: nil, externalUrl: url.absoluteString)
  }

  private func emitState() {
    endRefreshingWhenLoaded()
    // A tab with no page yet whose navigation became a download (a download link typed into a new tab) says so, so it
    // goes back to the start page instead of keeping the file's address and downloading it again when restored.
    let blank = firstNavigationBecameDownload && webView.backForwardList.currentItem == nil
    var state: [String: Any] = [
      "url": blank ? "" : webView.url?.absoluteString ?? "",
      "title": blank ? "" : webView.title ?? "",
      "progress": blank ? 0.0 : webView.estimatedProgress,
      "isLoading": blank ? false : webView.isLoading,
      "canGoBack": webView.canGoBack,
      "canGoForward": webView.canGoForward
    ]
    if blank { state["blank"] = true }
    onNavigationStateChange(state)
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    let elapsed = CACurrentMediaTime() - lastScrollEmission
    if elapsed >= 0.05 {
      pendingScroll?.cancel()
      pendingScroll = nil
      emitScroll()
    } else if pendingScroll == nil {
      let pending = DispatchWorkItem { [weak self] in
        self?.pendingScroll = nil
        self?.emitScroll()
      }
      pendingScroll = pending
      DispatchQueue.main.asyncAfter(deadline: .now() + (0.05 - elapsed), execute: pending)
    }
  }

  private func emitScroll() {
    let offset = max(0, webView.scrollView.contentOffset.y)
    let delta = offset - lastScrollOffset
    lastScrollOffset = offset
    lastScrollEmission = CACurrentMediaTime()
    onScroll(["offsetY": offset, "deltaY": delta])
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    // A link to another app asks first (B5), then stays cancelled here; the web page it came from stays open.
    guard let url = navigationAction.request.url else {
      decisionHandler(.cancel)
      return
    }
    if !isWebURL(url) {
      if navigationAction.targetFrame?.isMainFrame != false, isExternalURL(url) { requestExternal(url) }
      decisionHandler(.cancel)
      return
    }
    if navigationAction.shouldPerformDownload {
      decisionHandler(.download)
      return
    }
    if navigationAction.targetFrame?.isMainFrame == true {
      if (navigationAction.request.httpMethod ?? "GET") == "GET", let replacement = BayTracking.clean(url) ?? httpsUpgrade(url) {
        decisionHandler(.cancel)
        webView.load(URLRequest(url: replacement))
        return
      }
      applyContentRules(for: url)
      applyScriptlets(for: url)
    }
    decisionHandler(.allow)
  }

  /// Attachments and types WebKit can't show become downloads.
  func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
               decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
    let attachment = disposition.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("attachment")
    decisionHandler(attachment || !navigationResponse.canShowMIMEType ? .download : .allow)
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    BayDownloads.shared.track(download, url: navigationAction.request.url, isPrivate: isPrivate)
    navigationBecameDownload()
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    BayDownloads.shared.track(download, url: navigationResponse.response.url, isPrivate: isPrivate)
    navigationBecameDownload()
  }

  /// The navigation never finishes as a page: the view stays on the page it started from, or none.
  private func navigationBecameDownload() {
    if webView.backForwardList.currentItem == nil { firstNavigationBecameDownload = true }
    emitState()
  }

  private func httpsUpgrade(_ url: URL) -> URL? {
    guard url.scheme?.lowercased() == "http", let host = url.host?.lowercased(), !BayHTTPS.isLocal(host),
          !BayHTTPS.httpOnlyHosts.contains(host) else { return nil }
    if let upgraded = upgradedHosts[host], Date().timeIntervalSince(upgraded) < 5 {
      // The HTTPS page redirected back to HTTP: the site doesn't serve HTTPS properly, so keep HTTP.
      BayHTTPS.httpOnlyHosts.insert(host)
      return nil
    }
    var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    components?.scheme = "https"
    if components?.port == 80 { components?.port = nil }
    guard let secure = components?.url else { return nil }
    upgradedHosts[host] = Date()
    return secure
  }

  /// Falls back to HTTP when an upgraded HTTPS load can't connect; returns true when it did.
  private func fallBackToHTTP(after error: NSError) -> Bool {
    let failing = (error.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? webView.url
    let insecureErrors = [NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateUntrusted,
                          NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateNotYetValid, NSURLErrorCannotConnectToHost,
                          NSURLErrorTimedOut, NSURLErrorNetworkConnectionLost]
    guard let failing, failing.scheme == "https", let host = failing.host?.lowercased(), upgradedHosts[host] != nil,
          insecureErrors.contains(error.code) else { return false }
    BayHTTPS.httpOnlyHosts.insert(host)
    var components = URLComponents(url: failing, resolvingAgainstBaseURL: false)
    components?.scheme = "http"
    guard let insecure = components?.url else { return false }
    webView.load(URLRequest(url: insecure))
    return true
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
      if isWebURL(url) {
        webView.load(navigationAction.request)
      } else if isExternalURL(url) {
        requestExternal(url)
      }
    }
    return nil
  }

  // Links: WebKit's context-menu delegate covers every frame and shadow DOM, so Bay's link menu fires for iframe
  // links too (Android's hit test already covers them). The RN sheet is the one design; the native menu is
  // suppressed with an empty configuration after emitting onLinkPress. Text selection outside links is untouched.
  func webView(_ webView: WKWebView, contextMenuConfigurationForElement elementInfo: WKContextMenuElementInfo,
               completionHandler: @escaping (UIContextMenuConfiguration?) -> Void) {
    guard let linkURL = elementInfo.linkURL, isWebURL(linkURL) else {
      // Not a web link (text, image without a link): keep WebKit's default handling (selection, image menu).
      completionHandler(nil)
      return
    }
    let address = linkURL.absoluteString
    onLinkPress(["url": address, "title": address, "x": NSNull(), "y": NSNull()])
    // The shared sheet is the menu, so the native one is empty rather than default.
    completionHandler(UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { _ in UIMenu(children: []) })
  }

  // MARK: Page requests (I3): alert/confirm/prompt held until the shared sheet answers.

  /// One pending dialog, unified as (accepted, prompt value). Alert ignores both, confirm uses accepted, prompt uses both.
  private var pendingPageRequests: [String: (Bool, String?) -> Void] = [:]
  /// HTTP Basic/Digest challenges held until the shared sheet answers; a nil credential cancels the challenge.
  private var pendingAuthRequests: [String: (URLCredential?) -> Void] = [:]

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let id = UUID().uuidString
    pendingPageRequests[id] = { _, _ in completionHandler() }
    emitPageRequest(id: id, kind: "alert", message: message, defaultValue: nil)
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let id = UUID().uuidString
    pendingPageRequests[id] = { accepted, _ in completionHandler(accepted) }
    emitPageRequest(id: id, kind: "confirm", message: message, defaultValue: nil)
  }

  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?, Bool) -> Void) {
    let id = UUID().uuidString
    pendingPageRequests[id] = { accepted, value in
      if accepted { completionHandler(value, true) } else { completionHandler(nil, false) }
    }
    emitPageRequest(id: id, kind: "prompt", message: prompt, defaultValue: defaultText)
  }

  private func emitPageRequest(id: String, kind: String, message: String, defaultValue: String?, realm: String? = nil,
                               externalUrl: String? = nil) {
    var body: [String: Any] = ["id": id, "kind": kind, "message": String(message.prefix(2000)), "url": webView.url?.absoluteString ?? ""]
    if let defaultValue { body["defaultValue"] = String(defaultValue.prefix(2000)) }
    if let realm, !realm.isEmpty { body["realm"] = String(realm.prefix(200)) }
    if let externalUrl { body["externalUrl"] = String(externalUrl.prefix(2048)) }
    onPageRequest(body)
  }

  /// The server's HTTP sign-in (Basic, Digest or NTLM), answered from the shared sheet. Server-trust challenges keep
  /// WebKit's own certificate validation.
  func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
               completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    let space = challenge.protectionSpace
    let signInMethods = [NSURLAuthenticationMethodHTTPBasic, NSURLAuthenticationMethodHTTPDigest, NSURLAuthenticationMethodNTLM]
    guard signInMethods.contains(space.authenticationMethod) else {
      completionHandler(.performDefaultHandling, nil)
      return
    }
    let id = UUID().uuidString
    pendingAuthRequests[id] = { credential in
      if let credential {
        completionHandler(.useCredential, credential)
      } else {
        completionHandler(.cancelAuthenticationChallenge, nil)
      }
    }
    emitPageRequest(id: id, kind: "auth", message: "", defaultValue: nil, realm: space.realm)
  }

  func answerPageRequest(id: String, accepted: Bool, value: String?, username: String?, password: String?) {
    if let pending = pendingAuthRequests.removeValue(forKey: id) {
      // Kept for the session so the page's other requests don't ask again, never saved to disk.
      let credential = accepted ? URLCredential(user: username ?? "", password: password ?? "", persistence: .forSession) : nil
      pending(credential)
      return
    }
    pendingPageRequests.removeValue(forKey: id)?(accepted, value)
  }

  private func cancelPageRequests() {
    let pending = pendingPageRequests
    pendingPageRequests.removeAll()
    for (_, handler) in pending { handler(false, nil) }

    let pendingAuth = pendingAuthRequests
    pendingAuthRequests.removeAll()
    for (_, handler) in pendingAuth { handler(nil) }
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    if fallBackToHTTP(after: error as NSError) { return }
    emitError(error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    emitError(error)
  }

  private func emitError(_ error: Error) {
    refreshControl.endRefreshing()
    let nativeError = error as NSError
    guard nativeError.code != NSURLErrorCancelled else { return }
    // 102: the response became a download. 204: a media file is playing in its own document. Neither is a failure.
    if nativeError.domain == "WebKitErrorDomain" && [102, 204].contains(nativeError.code) { return }
    onNavigationError([
      "url": nativeError.userInfo[NSURLErrorFailingURLStringErrorKey] as? String ?? webView.url?.absoluteString ?? "",
      "code": "\(nativeError.domain):\(nativeError.code)",
      "message": nativeError.localizedDescription
    ])
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    refreshControl.endRefreshing()
    onNavigationError(["url": webView.url?.absoluteString ?? "", "code": "renderer-terminated",
                       "message": "The page stopped responding. Reload to try again."])
  }
}

/// Holds the view weakly: WebKit's user content controller keeps its message handlers alive.
private final class BayPageMessageProxy: NSObject, WKScriptMessageHandler {
  weak var view: BayEngineView?

  init(view: BayEngineView) {
    self.view = view
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    view?.receive(message)
  }
}
