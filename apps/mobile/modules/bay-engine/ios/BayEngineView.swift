import ExpoModulesCore
import UIKit
import WebKit

private final class InvalidAddressException: Exception, @unchecked Sendable {
  override var reason: String { "Only HTTP and HTTPS addresses can be opened." }
}

class BayEngineView: ExpoView, WKNavigationDelegate, WKUIDelegate, UIScrollViewDelegate, UIGestureRecognizerDelegate {
  private(set) var webView: WKWebView
  let onNavigationStateChange = EventDispatcher()
  let onNavigationError = EventDispatcher()
  let onScroll = EventDispatcher()
  let onLinkPress = EventDispatcher()
  private let refreshControl = UIRefreshControl()
  private var observations: [NSKeyValueObservation] = []
  private var lastScrollOffset: CGFloat = 0
  private var lastScrollEmission: CFTimeInterval = 0
  private var pendingScroll: DispatchWorkItem?
  private var snapshotURL: URL?
  private var startedLoading = false
  private var pendingInitialURL: String?
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
    configuration.userContentController.addUserScript(linkStyle)
    return WKWebView(frame: .zero, configuration: configuration)
  }

  // Link long-presses open Bay's link menu (see longPress), so WebKit's callout and link-text selection are off.
  private static let linkStyle = WKUserScript(
    source: """
      const style = document.createElement('style');
      style.textContent = 'a[href], a[href] * { -webkit-touch-callout: none !important; -webkit-user-select: none !important; }';
      document.documentElement.appendChild(style);
      """,
    injectionTime: .atDocumentEnd, forMainFrameOnly: false, in: .defaultClient)

  /// The page's scriptlets (`##+js`), set before WebKit creates its document so they run in the page's own world ahead
  /// of its scripts. Replaced on every main-frame navigation.
  private func applyScriptlets(for url: URL) {
    let controller = webView.configuration.userContentController
    controller.removeAllUserScripts()
    controller.addUserScript(Self.linkStyle)
    guard let script = BayContentBlocker.shared.scriptlets(for: url) else { return }
    NSLog("BayContentBlocker: scriptlets for %@: %d chars", url.host ?? "", script.count)
    controller.addUserScript(WKUserScript(source: "try{\(script)}catch(e){}", injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
  }

  private func setUpWebView() {
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = true
    webView.accessibilityElementsHidden = !isActive
    webView.scrollView.delegate = self
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.scrollView.alwaysBounceVertical = true
    webView.scrollView.refreshControl = pullToRefreshEnabled ? refreshControl : nil
    let press = UILongPressGestureRecognizer(target: self, action: #selector(longPress(_:)))
    press.minimumPressDuration = 0.5
    press.delegate = self
    webView.addGestureRecognizer(press)
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
    observations = []
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
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    webView.frame = bounds
  }

  func load(_ address: String) throws {
    guard let url = URL(string: address), isWebURL(url) else { throw InvalidAddressException() }
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

  func stop() {
    webView.stopLoading()
    refreshControl.endRefreshing()
  }

  @objc private func refresh() {
    guard pullToRefreshEnabled, webView.url != nil else {
      refreshControl.endRefreshing()
      return
    }
    webView.reload()
  }

  func snapshot(_ promise: Promise) {
    guard bounds.width > 0, bounds.height > 0, webView.url != nil else {
      promise.resolve(nil as String?)
      return
    }
    let configuration = WKSnapshotConfiguration()
    configuration.rect = webView.bounds
    webView.takeSnapshot(with: configuration) { [weak self] image, error in
      guard let self else { promise.resolve(nil as String?); return }
      if let error { promise.reject(error); return }
      guard let image, image.size.width > 0, image.size.height > 0, let directory = BayEngineSnapshots.directory else {
        promise.resolve(nil as String?)
        return
      }
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
      do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("\(UUID().uuidString).jpg")
        try data.write(to: url, options: .atomic)
        if let previous = self.snapshotURL { try? FileManager.default.removeItem(at: previous) }
        self.snapshotURL = url
        promise.resolve(url.absoluteString)
      } catch {
        promise.reject(error)
      }
    }
  }

  private func isWebURL(_ url: URL) -> Bool {
    ["http", "https"].contains(url.scheme?.lowercased() ?? "") && url.host?.isEmpty == false
  }

  private func emitState() {
    if !webView.isLoading { refreshControl.endRefreshing() }
    onNavigationStateChange([
      "url": webView.url?.absoluteString ?? "",
      "title": webView.title ?? "",
      "progress": webView.estimatedProgress,
      "isLoading": webView.isLoading,
      "canGoBack": webView.canGoBack,
      "canGoForward": webView.canGoForward
    ])
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
    // External schemes require an explicit handoff UI in a later phase.
    guard let url = navigationAction.request.url, isWebURL(url) else {
      decisionHandler(.cancel)
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
    if navigationAction.targetFrame == nil, let url = navigationAction.request.url, isWebURL(url) {
      webView.load(navigationAction.request)
    }
    return nil
  }

  // Links: WebKit's callout is turned off by the injected style below, and this recognizer asks the page, in an
  // isolated script world, which link is under the finger. Elsewhere WebKit keeps its own text selection.
  @objc private func longPress(_ gesture: UILongPressGestureRecognizer) {
    guard gesture.state == .began, webView.url != nil else { return }
    let point = gesture.location(in: webView)
    let zoom = max(webView.scrollView.zoomScale, 0.01)
    let script = """
      const a = document.elementFromPoint(x, y)?.closest('a[href]');
      return a ? [a.href, (a.innerText || a.title || a.getAttribute('aria-label') || '').trim()] : null;
      """
    webView.callAsyncJavaScript(script, arguments: ["x": point.x / zoom, "y": point.y / zoom], in: nil, in: .defaultClient) { [weak self] result in
      guard let self, case .success(let value) = result, let link = value as? [Any], link.count == 2,
            let address = link[0] as? String, let url = URL(string: address), self.isWebURL(url) else { return }
      let text = (link[1] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(240)) } ?? address
      self.onLinkPress([
        "url": url.absoluteString, "title": text,
        "x": min(1, max(0, point.x / max(1, self.bounds.width))),
        "y": min(1, max(0, point.y / max(1, self.bounds.height)))
      ])
    }
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                         shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
    true
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
