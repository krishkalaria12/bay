import BayCore
import UIKit
import WebKit

/// One page view: a `WKWebView` with Bay's navigation policy, content blocking, page requests, swipes, snapshots and
/// saved tab state. Keep it in the view tree while a tab is open; navigate through its methods. Everything it reports
/// arrives through `onEvent`.
public final class EngineView: UIView, WKNavigationDelegate, WKUIDelegate, UIScrollViewDelegate, UIGestureRecognizerDelegate {
  public private(set) var webView: WKWebView
  /// Everything the view reports, on the main thread.
  public var onEvent: ((EngineEvent) -> Void)?

  private func emit(_ event: EngineEvent) {
    onEvent?(event)
  }

  /// Swipe to navigate (C5): anywhere on the page, the edges (WebKit's own edge swipe), or off.
  public var swipeMode: SwipeMode = .edges {
    didSet { webView.allowsBackForwardNavigationGestures = swipeMode != .off }
  }
  /// Open app links in (C12): the app first offers a tapped link to another site to the app that claims it as a
  /// universal link; the browser keeps every link here.
  public var appLinks: AppLinks = .app
  /// Bay's own swipe across the page (C5, C6), beside WebKit's edge swipe.
  private lazy var swipePan = UIPanGestureRecognizer(target: self, action: #selector(swipe(_:)))
  /// Requests the blocker stopped on this page, each counted once (C2).
  private var blockedRequests = Set<String>()
  private lazy var blockedProxy = BayBlockedMessageProxy(view: self)
  /// The page on screen, offered to the user's other Apple devices (C14). Never a private page.
  private var handoff: NSUserActivity?
  private lazy var messageProxy = BayPageMessageProxy(view: self)
  private let refreshControl = UIRefreshControl()
  /// When the current pull to refresh started: the spinner stays at least briefly, so a cached reload doesn't flash it.
  private var refreshStartedAt: CFTimeInterval = 0
  private var observations: [NSKeyValueObservation] = []
  /// The page's offset at the last scroll, and how far the person has scrolled it since the last report.
  private var seenScrollOffset: CGFloat = 0
  private var userScroll: CGFloat = 0
  private var lastScrollEmission: CFTimeInterval = 0
  private var pendingScroll: DispatchWorkItem?
  private var snapshotURL: URL?
  private var startedLoading = false
  private var pendingInitialURL: String?
  /// The tab's saved state (B6), restored before its first load; the tab id, or nil for private tabs.
  public var stateKey: String? {
    didSet {
      if stateKey != oldValue { restoreState() }
    }
  }
  /// A saved page came back, so `initialUrl` must not load over it.
  private var restoredState = false
  /// Automatic reloads after the system kills a page's renderer (one, then the error screen).
  private var rendererReloads = 0
  /// The page's image long-press watcher (B13) reports `{ type: "image" }`: `ready` once armed, then one report per
  /// bare-image press, so WebKit's own image menu can be kept down while Bay's menu answers.
  private var imageMenuReady = false
  private var imagePressAt: Date?
  /// The tab's first navigation became a download, so it has no page; reported as `blank` while that's still so.
  private var firstNavigationBecameDownload = false
  /// Hosts this view moved from HTTP to HTTPS, with when; an HTTPS page that sends the view straight back keeps HTTP.
  private var upgradedHosts: [String: Date] = [:]

  /// Private pages use the shared non-persistent store. Set before the first load (React sets props on creation).
  public var isPrivate = false {
    didSet {
      if isPrivate != oldValue && !startedLoading { replaceWebView() }
    }
  }

  /// The space whose website data the page uses (BaySpaceProfiles). A page that has loaded moves to the new space's
  /// store and opens its address again there, as a tab moved to another desktop space does.
  public var profile = BaySpaceProfiles.personal {
    didSet {
      guard profile != oldValue else { return }
      let address = startedLoading ? webView.url : nil
      replaceWebView()
      if let address { webView.load(URLRequest(url: address)) }
    }
  }

  /// How much of the page's bottom the app's floating bar covers. On iOS 26+ WebKit shrinks the layout viewport by it,
  /// so what a page pins to its bottom sits above the bar while content still scrolls under the glass; earlier, the
  /// scroll view is inset so the last of the page can scroll clear of it.
  public var obscuredBottom: CGFloat = 0 {
    didSet {
      if obscuredBottom != oldValue { applyObscuredBottom() }
    }
  }

  private func applyObscuredBottom() {
    if #available(iOS 26, *) {
      webView.obscuredContentInsets = UIEdgeInsets(top: 0, left: 0, bottom: obscuredBottom, right: 0)
    } else {
      webView.scrollView.contentInset.bottom = obscuredBottom
      webView.scrollView.verticalScrollIndicatorInsets.bottom = obscuredBottom
    }
  }

  /// Hidden tabs stay mounted; keep them out of VoiceOver. Leaving the screen is also a good moment to save (B6):
  /// the tab may be the next one unmounted for memory.
  public var isActive = true {
    didSet {
      webView.accessibilityElementsHidden = !isActive
      if !isActive { saveState() }
      updateHandoff()
    }
  }

  /// Hidden tabs that aren't playing media are hidden from WebKit too, which then throttles their timers and animations.
  public var isSuspended = false {
    didSet { webView.isHidden = isSuspended }
  }

  public var pullToRefreshEnabled = true {
    didSet {
      webView.scrollView.refreshControl = pullToRefreshEnabled ? refreshControl : nil
      if !pullToRefreshEnabled { refreshControl.endRefreshing() }
    }
  }

  /// Desktop site (B12): the page asks its site again with a desktop browser's agent, so the server answers with
  /// the desktop layout, and WebKit lays it out as a desktop page (the navigation policy). The page reloads when this
  /// changes.
  public var desktopMode = false {
    didSet {
      guard desktopMode != oldValue else { return }
      // A custom agent replaces WebKit's own wholesale (the `applicationNameForUserAgent` suffix lives inside it).
      webView.customUserAgent = desktopMode ? Self.macOSUserAgent : nil
      if startedLoading { webView.reload() }
    }
  }

  /// A view in a private session or a space's store, set from the start so the first page loads there.
  public init(isPrivate: Bool = false, profile: String = "personal") {
    self.isPrivate = isPrivate
    self.profile = profile
    webView = Self.makeWebView(isPrivate: isPrivate, profile: profile, desktopMode: false)
    super.init(frame: .zero)
    clipsToBounds = true
    refreshControl.addTarget(self, action: #selector(refresh), for: .valueChanged)
    setUpWebView()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("EngineView is made in code")
  }

  private static func makeWebView(isPrivate: Bool, profile: String, desktopMode: Bool) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = isPrivate ? BayPrivateBrowsing.dataStore() : BaySpaceProfiles.dataStore(for: profile)
    // Video plays in the page when it asks to (playsinline), as in Safari.
    configuration.allowsInlineMediaPlayback = true
    // Videos can leave the page into picture in picture (B17), as in Safari.
    configuration.allowsPictureInPictureMediaPlayback = true
    // Google won't sign anyone in from what it can tell is an app's embedded web view ("This browser or app may not be
    // secure", OAuth's disallowed_useragent): WKWebView's user agent ends at "Mobile/15E148", without Safari's
    // "Version/… Safari/…" tokens. Bay is a browser, so it presents as Safari does (Android drops `; wv` likewise).
    configuration.applicationNameForUserAgent = safariUserAgentSuffix
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.customUserAgent = desktopMode ? Self.macOSUserAgent : nil

    return webView
  }

  /// Safari on macOS, at the version this device's Safari shows: what a desktop browser presents (B12).
  private static let macOSUserAgent: String = {
    let parts = UIDevice.current.systemVersion.split(separator: ".")
    let version = "\(parts.first ?? "26").\(parts.count > 1 ? parts[1] : "0")"
    return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/\(version) Safari/605.1.15"
  }()

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
    controller.addUserScript(WKUserScript(source: Self.failedLoadScript, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .defaultClient))
    guard let script = BayContentBlocker.shared.scriptlets(for: url) else { return }
    NSLog("BayContentBlocker: scriptlets for %@: %d chars", url.host ?? "", script.count)
    controller.addUserScript(WKUserScript(source: "try{\(script)}catch(e){}", injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
  }

  private func setUpWebView() {
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = swipeMode != .off
    swipePan.delegate = self
    swipePan.maximumNumberOfTouches = 1
    webView.addGestureRecognizer(swipePan)
    // Sites' custom players call `element.requestFullscreen()`, which WebKit only honours when this is on
    // (native `<video>` fullscreen already works with `allowsInlineMediaPlayback`). Android gets the same
    // behaviour from `onShowCustomView` in its WebChromeClient.
    if #available(iOS 15.4, *) { webView.configuration.preferences.isElementFullscreenEnabled = true }
    webView.accessibilityElementsHidden = !isActive
    webView.isHidden = isSuspended
    webView.scrollView.delegate = self
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    applyObscuredBottom()
    webView.scrollView.alwaysBounceVertical = true
    webView.scrollView.refreshControl = pullToRefreshEnabled ? refreshControl : nil
    // Page scripts run in this isolated world (see evaluate), so only they can post to the app.
    webView.configuration.userContentController.add(messageProxy, contentWorld: .defaultClient, name: "bay")
    // What failed to load on the page, for the blocked count (C2); from every frame.
    webView.configuration.userContentController.add(blockedProxy, contentWorld: .defaultClient, name: "bayBlocked")
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
    webView.configuration.userContentController.removeScriptMessageHandler(forName: "bayBlocked", contentWorld: .defaultClient)
    webView.removeGestureRecognizer(swipePan)
    webView.navigationDelegate = nil
    webView.uiDelegate = nil
    webView.scrollView.delegate = nil
    webView.removeFromSuperview()
    webView = Self.makeWebView(isPrivate: isPrivate, profile: profile, desktopMode: desktopMode)
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

  override public func layoutSubviews() {
    super.layoutSubviews()
    webView.frame = bounds
  }

  /// Opens an HTTP(S) address; completion and failures arrive as events.
  public func load(_ address: String) throws {
    guard let url = URL(string: address), isWebURL(url) else { throw EngineError.invalidAddress }
    cancelPageRequests()
    startedLoading = true
    webView.load(URLRequest(url: url))
  }

  /// Loads once, when the view is created, unless a navigation already started. Invalid addresses are ignored.
  /// Waits a turn of the run loop so the other initial props (`private` in particular) apply first.
  public func loadInitial(_ address: String?) {
    guard !startedLoading, let address, !address.isEmpty else { return }
    pendingInitialURL = address
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.startedLoading else { return }
      // A restored page supplies its own address and history; only fall back if WebKit drops it.
      if self.restoredState {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
          guard let self, !self.startedLoading, self.webView.url == nil, self.webView.backForwardList.currentItem == nil,
                let address = self.pendingInitialURL else { return }
          self.pendingInitialURL = nil
          try? self.load(address)
        }
        return
      }
      guard let address = self.pendingInitialURL else { return }
      self.pendingInitialURL = nil
      try? self.load(address)
    }
  }

  /// Restores the tab's back/forward history, scroll position and form text saved by a previous view (B6).
  private func restoreState() {
    guard let key = stateKey, let state = BayEngineTabStates.load(key: key), !startedLoading else { return }
    webView.interactionState = state
    restoredState = true
  }

  /// Saves the page state for `stateKey` now (B6); private tabs leave nothing behind.
  public func saveState() {
    guard !isPrivate, let key = stateKey, let state = webView.interactionState else { return }
    BayEngineTabStates.save(state, key: key)
  }

  /// Runs a page script (the body of an async function) in Bay's isolated world and answers with its result as JSON
  /// text. `post(message)` in the script sends a `pageMessage` event.
  public func evaluate(_ script: String) async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
      evaluate(script) { continuation.resume(with: $0) }
    }
  }

  private func evaluate(_ script: String, completion: @escaping (Result<String, Error>) -> Void) {
    let body = """
      const post = (message) => window.webkit.messageHandlers.bay.postMessage(JSON.stringify(message));
      const value = await (async () => {
      \(script)
      })();
      return JSON.stringify(value === undefined ? null : value);
      """
    webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .defaultClient) { result in
      switch result {
      case .success(let value): completion(.success(value as? String ?? "null"))
      case .failure(let error): completion(.failure(EngineError.pageScript(error.localizedDescription)))
      }
    }
  }

  fileprivate func receive(_ message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, let text = message.body as? String else { return }
    if let image = imageMessage(text) {
      // `ready` says the watcher is armed on this document; anything with a source is one long press.
      if image["src"] == nil { imageMenuReady = true } else { imagePressAt = Date() }
    }
    emit(.pageMessage(text))
  }

  /// Parses a page message as an image-watcher report (B13); nil for anything else.
  private func imageMessage(_ text: String) -> [String: Any]? {
    guard
      let data = text.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      (object["type"] as? String) == "image"
    else { return nil }

    return object
  }

  public func stop() {
    webView.stopLoading()
    refreshControl.endRefreshing()
  }

  public func goBack() {
    webView.goBack()
  }

  public func goForward() {
    webView.goForward()
  }

  public func reload() {
    webView.reload()
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

  /// The colours the page shows along its top and bottom edges, as drawn ([r, g, b] each), or nil before it has drawn.
  /// Read from a thumbnail of the page rather than its styles: a video, a picture or a canvas under the edge has no
  /// background colour to read, and Shorts' white page behind a dark video read as white. The page runs on under the
  /// bar, so the bottom edge is what the bar sits on.
  public func edgeColors() async -> (top: [Double], bottom: [Double])? {
    guard !isSuspended, bounds.width > 0, bounds.height > 0, webView.url != nil else { return nil }
    let configuration = WKSnapshotConfiguration()
    configuration.rect = webView.bounds
    configuration.snapshotWidth = NSNumber(value: Self.edgeSampleWidth)
    let image: UIImage? = await withCheckedContinuation { continuation in
      webView.takeSnapshot(with: configuration) { image, _ in continuation.resume(returning: image) }
    }
    guard let picture = image?.cgImage else { return nil }
    let width = Int(Self.edgeSampleWidth)
    let height = max(4, Int((Double(picture.height) * Double(width) / Double(max(1, picture.width))).rounded()))
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
      guard
        let context = CGContext(
          data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
      else { return false }
      context.draw(picture, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }
    guard drawn else { return nil }
    return (Self.edgeColor(pixels, width: width, row: 0), Self.edgeColor(pixels, width: width, row: height - 2))
  }

  /// How wide the thumbnail is that the page's edge colours are read from, in points.
  private static let edgeSampleWidth: CGFloat = 48

  /// The colour most of two rows of RGBX pixels show, from `row` (the top row first): the pixels are put in coarse bins
  /// and the fullest bin's average is the answer, so a line of text or an icon along the edge doesn't tint it.
  private static func edgeColor(_ pixels: [UInt8], width: Int, row: Int) -> [Double] {
    var bins: [Int: (count: Int, red: Int, green: Int, blue: Int)] = [:]
    for y in row..<(row + 2) {
      for x in 0..<width {
        let at = (y * width + x) * 4
        let (red, green, blue) = (Int(pixels[at]), Int(pixels[at + 1]), Int(pixels[at + 2]))
        let key = (red >> 4) << 8 | (green >> 4) << 4 | blue >> 4
        let bin = bins[key] ?? (0, 0, 0, 0)
        bins[key] = (bin.count + 1, bin.red + red, bin.green + green, bin.blue + blue)
      }
    }
    guard let fullest = bins.values.max(by: { $0.count < $1.count }) else { return [255, 255, 255] }
    let count = Double(fullest.count)
    return [Double(fullest.red) / count, Double(fullest.green) / count, Double(fullest.blue) / count]
  }

  /// WebKit draws on the main thread; the resize, JPEG encoding and file write run in the background. A suspended
  /// (hidden) page resolves nil: WebKit may not have drawn it.
  public func snapshot() async throws -> String? {
    try await withCheckedThrowingContinuation { continuation in
      snapshot { continuation.resume(with: $0) }
    }
  }

  private func snapshot(_ done: @escaping (Result<String?, Error>) -> Void) {
    guard !isSuspended, bounds.width > 0, bounds.height > 0, webView.url != nil else {
      done(.success(nil))
      return
    }
    let configuration = WKSnapshotConfiguration()
    configuration.rect = webView.bounds
    webView.takeSnapshot(with: configuration) { [weak self] image, error in
      if let error { done(.failure(error)); return }
      guard let image, image.size.width > 0, image.size.height > 0, let directory = BayEngineSnapshots.directory else {
        done(.success(nil))
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
          DispatchQueue.main.async { done(.success(nil)) }
          return
        }
        let url = directory.appendingPathComponent("\(UUID().uuidString).jpg")
        do {
          try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
          try data.write(to: url, options: .atomic)
        } catch {
          DispatchQueue.main.async { done(.failure(error)) }
          return
        }
        // snapshotURL is only read and swapped on the main thread, so overlapping snapshots can't race.
        DispatchQueue.main.async {
          if let previous = self?.snapshotURL { try? FileManager.default.removeItem(at: previous) }
          self?.snapshotURL = url
          done(.success(url.absoluteString))
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
    emitPageRequest(id: id, kind: .external, message: "", defaultValue: nil, externalUrl: url.absoluteString)
  }

  private func emitState() {
    endRefreshingWhenLoaded()
    updateHandoff()
    // A tab with no page yet whose navigation became a download (a download link typed into a new tab) says so, so it
    // goes back to the start page instead of keeping the file's address and downloading it again when restored.
    let blank = firstNavigationBecameDownload && webView.backForwardList.currentItem == nil
    emit(.navigation(NavigationState(
      url: blank ? "" : webView.url?.absoluteString ?? "",
      title: blank ? "" : webView.title ?? "",
      progress: blank ? 0 : webView.estimatedProgress,
      isLoading: blank ? false : webView.isLoading,
      canGoBack: webView.canGoBack,
      canGoForward: webView.canGoForward,
      blank: blank
    )))
  }

  public func scrollViewDidScroll(_ scrollView: UIScrollView) {
    // Under a finger, or its fling; anything else is the page moving itself (a load, a resize, a jump to an anchor).
    let offset = max(0, scrollView.contentOffset.y)
    if scrollView.isTracking || scrollView.isDragging || scrollView.isDecelerating {
      userScroll += offset - seenScrollOffset
    }
    seenScrollOffset = offset
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
    let delta = userScroll
    userScroll = 0
    lastScrollEmission = CACurrentMediaTime()
    emit(.scroll(offsetY: Double(max(0, webView.scrollView.contentOffset.y)), deltaY: Double(delta)))
  }

  public func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
               preferences: WKWebpagePreferences,
               decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
    // Desktop site (B12) lays the page out as a desktop browser would, wide and shrunk to fit, as Safari's "Request
    // Desktop Website" does; the agent stays the macOS one (`customUserAgent`), which has no "Mobile" token.
    preferences.preferredContentMode = desktopMode ? .desktop : .mobile
    // A link to another app asks first (B5), then stays cancelled here; the web page it came from stays open.
    guard let url = navigationAction.request.url else {
      decisionHandler(.cancel, preferences)
      return
    }
    if !isWebURL(url) {
      if navigationAction.targetFrame?.isMainFrame != false, isExternalURL(url) { requestExternal(url) }
      decisionHandler(.cancel, preferences)
      return
    }
    if navigationAction.shouldPerformDownload {
      decisionHandler(.download, preferences)
      return
    }
    // Open app links in (C12): a link tapped in the page to another site goes to the app that claims it, when one
    // does; otherwise it loads here. Typed addresses, redirects and links within the site always stay.
    if appLinks == .app, navigationAction.navigationType == .linkActivated, navigationAction.targetFrame?.isMainFrame == true,
       Self.isAnotherSite(url, from: webView.url) {
      var answered = false
      let answer: (Bool) -> Void = { [weak self] opened in
        guard !answered else { return }
        answered = true
        if opened {
          decisionHandler(.cancel, preferences)
        } else if let self {
          self.allowNavigation(navigationAction, to: url, preferences: preferences, decisionHandler: decisionHandler)
        } else {
          decisionHandler(.allow, preferences)
        }
      }
      UIApplication.shared.open(url, options: [.universalLinksOnly: true]) { opened in DispatchQueue.main.async { answer(opened) } }
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { answer(false) }
      return
    }
    allowNavigation(navigationAction, to: url, preferences: preferences, decisionHandler: decisionHandler)
  }

  /// The rest of a web navigation's policy: tracking parameters and HTTPS first, then the page's blocking rules.
  private func allowNavigation(_ navigationAction: WKNavigationAction, to url: URL, preferences: WKWebpagePreferences,
                               decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
    if navigationAction.targetFrame?.isMainFrame == true {
      if (navigationAction.request.httpMethod ?? "GET") == "GET", let replacement = BayTracking.clean(url) ?? httpsUpgrade(url) {
        decisionHandler(.cancel, preferences)
        webView.load(URLRequest(url: replacement))
        return
      }
      applyContentRules(for: url)
      applyScriptlets(for: url)
    }
    decisionHandler(.allow, preferences)
  }

  /// Attachments and types WebKit can't show become downloads. An HTTP error never does: it is the server's answer
  /// to show as a page, as Safari and Chrome do. A cancelled sign-in's 401, which often has no body and no
  /// Content-Type, would otherwise count as a type WebKit can't show and come back as a refused download.
  public func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
               decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    let http = navigationResponse.response as? HTTPURLResponse
    if let status = http?.statusCode, status >= 400 {
      decisionHandler(.allow)
      return
    }
    let disposition = http?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
    let attachment = disposition.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("attachment")
    decisionHandler(attachment || !navigationResponse.canShowMIMEType ? .download : .allow)
  }

  public func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    BayDownloads.shared.track(download, url: navigationAction.request.url, isPrivate: isPrivate, webView: webView)
    navigationBecameDownload()
  }

  public func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    BayDownloads.shared.track(download, url: navigationResponse.response.url, isPrivate: isPrivate, webView: webView)
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

  public func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
      if isWebURL(url) {
        // New windows (B19): a real tab, in this view's own session, that keeps this page as its opener. Loading it
        // here replaced the opener's page, which is how popup sign-ins lost it.
        emit(.newWindow(url: url.absoluteString, isPrivate: isPrivate))
      } else if isExternalURL(url) {
        requestExternal(url)
      }
    }
    return nil
  }

  // Links: WebKit's context-menu delegate covers every frame and shadow DOM, so Bay's link menu fires for iframe
  // links too (Android's hit test already covers them). The RN sheet is the one design; the native menu is
  // suppressed with an empty configuration after emitting onLinkPress. Text selection outside links is untouched.
  public func webView(_ webView: WKWebView, contextMenuConfigurationForElement elementInfo: WKContextMenuElementInfo,
               completionHandler: @escaping (UIContextMenuConfiguration?) -> Void) {
    guard let linkURL = elementInfo.linkURL, isWebURL(linkURL) else {
      // A bare image (B13): when the page's watcher reported this same press a moment ago, the menu is Bay's own and
      // WebKit's default image menu is kept down. Otherwise (text selection, or the watcher missed it) WebKit's
      // default handling stays (selection, image menu).
      if imageMenuReady, let pressed = imagePressAt, Date().timeIntervalSince(pressed) < 3 {
        completionHandler(UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { _ in UIMenu(children: []) })
      } else {
        completionHandler(nil)
      }
      return
    }
    let address = linkURL.absoluteString
    emit(.linkPress(LinkPress(url: address, title: address, x: nil, y: nil, image: false)))
    // The shared sheet is the menu, so the native one is empty rather than default.
    completionHandler(UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { _ in UIMenu(children: []) })
  }

  // MARK: Page requests (I3): alert/confirm/prompt held until the shared sheet answers.

  /// One pending dialog, unified as (accepted, prompt value). Alert ignores both, confirm uses accepted, prompt uses both.
  private var pendingPageRequests: [String: (Bool, String?) -> Void] = [:]
  /// HTTP Basic/Digest challenges held until the shared sheet answers; a nil credential cancels the challenge.
  private var pendingAuthRequests: [String: (URLCredential?) -> Void] = [:]

  public func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let id = UUID().uuidString
    pendingPageRequests[id] = { _, _ in completionHandler() }
    emitPageRequest(id: id, kind: .alert, message: message, defaultValue: nil)
  }

  public func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let id = UUID().uuidString
    pendingPageRequests[id] = { accepted, _ in completionHandler(accepted) }
    emitPageRequest(id: id, kind: .confirm, message: message, defaultValue: nil)
  }

  public func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    let id = UUID().uuidString
    // WebKit takes the text the page gets: nothing when the sheet is dismissed.
    pendingPageRequests[id] = { accepted, value in
      completionHandler(accepted ? (value ?? "") : nil)
    }
    emitPageRequest(id: id, kind: .prompt, message: prompt, defaultValue: defaultText)
  }

  private func emitPageRequest(id: String, kind: PageRequestKind, message: String, defaultValue: String?, realm: String? = nil,
                               externalUrl: String? = nil, permission: String? = nil) {
    emit(.pageRequest(PageRequest(
      id: id, kind: kind, message: String(message.prefix(2000)), defaultValue: defaultValue.map { String($0.prefix(2000)) },
      realm: realm.flatMap { $0.isEmpty ? nil : String($0.prefix(200)) }, externalUrl: externalUrl.map { String($0.prefix(2048)) },
      permission: permission, url: webView.url?.absoluteString ?? ""
    )))
  }

  /// The server's HTTP sign-in (Basic, Digest or NTLM), answered from the shared sheet. Server-trust challenges keep
  /// WebKit's own certificate validation.
  public func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
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
    emitPageRequest(id: id, kind: .auth, message: "", defaultValue: nil, realm: space.realm)
  }

  public func answerPageRequest(id: String, accepted: Bool, value: String?, username: String?, password: String?) {
    if let pending = pendingAuthRequests.removeValue(forKey: id) {
      // Kept for the session so the page's other requests don't ask again, never saved to disk.
      let credential = accepted ? URLCredential(user: username ?? "", password: password ?? "", persistence: .forSession) : nil
      pending(credential)
      return
    }
    pendingPageRequests.removeValue(forKey: id)?(accepted, value)
  }

  /// Camera and microphone (B7): the shared sheet asks before WebKit grants the page access. Location is WebKit's own
  /// system prompt, which uses the app's `NSLocationWhenInUseUsageDescription`.
  public func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
               initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
               decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    let permission: String

    switch type {
    case .camera: permission = "camera"
    case .microphone: permission = "microphone"
    case .cameraAndMicrophone: permission = "camera-microphone"
    @unknown default:
      decisionHandler(.deny)
      return
    }
    let id = UUID().uuidString
    pendingPageRequests[id] = { accepted, _ in decisionHandler(accepted ? .grant : .deny) }
    emitPageRequest(id: id, kind: .permission, message: "", defaultValue: nil, permission: permission)
  }

  private func cancelPageRequests() {
    let pending = pendingPageRequests
    pendingPageRequests.removeAll()
    for (_, handler) in pending { handler(false, nil) }

    let pendingAuth = pendingAuthRequests
    pendingAuthRequests.removeAll()
    for (_, handler) in pendingAuth { handler(nil) }
  }

  public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    if fallBackToHTTP(after: error as NSError) { return }
    emitError(error)
  }

  public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    emitError(error)
  }

  /// A finished load is worth keeping: history, scroll position and form text go to the tab's state file (B6).
  public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    rendererReloads = 0
    saveState()
  }

  /// A new page: nothing blocked on it yet (C2).
  public func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    blockedRequests = []
    emit(.blockedCount(0))
  }

  private func emitError(_ error: Error) {
    refreshControl.endRefreshing()
    let nativeError = error as NSError
    guard nativeError.code != NSURLErrorCancelled else { return }
    // 102: the response became a download. 204: a media file is playing in its own document. Neither is a failure.
    if nativeError.domain == "WebKitErrorDomain" && [102, 204].contains(nativeError.code) { return }
    emit(.failure(NavigationFailure(
      url: nativeError.userInfo[NSURLErrorFailingURLStringErrorKey] as? String ?? webView.url?.absoluteString ?? "",
      code: "\(nativeError.domain):\(nativeError.code)",
      message: nativeError.localizedDescription
    )))
  }

  public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    refreshControl.endRefreshing()
    // The system killed the page to reclaim memory; reopen it once before showing the error screen (B6).
    if rendererReloads < 1, webView.url != nil {
      rendererReloads += 1
      webView.reload()
      return
    }
    emit(.failure(NavigationFailure(url: webView.url?.absoluteString ?? "", code: "renderer-terminated",
                                    message: "The page stopped responding. Reload to try again.")))
  }
}

/// Holds the view weakly: WebKit's user content controller keeps its message handlers alive.
private final class BayPageMessageProxy: NSObject, WKScriptMessageHandler {
  weak var view: EngineView?

  init(view: EngineView) {
    self.view = view
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    view?.receive(message)
  }
}

// MARK: Swipes, Handoff and the blocked count (C5, C6, C14, C2)

extension EngineView {
  /// Whether `url` is on another site than the page at `current`: hosts without "www." that neither equal nor nest.
  static func isAnotherSite(_ url: URL, from current: URL?) -> Bool {
    guard let target = url.host?.lowercased(), !target.isEmpty else { return false }
    guard let page = current?.host?.lowercased(), !page.isEmpty else { return true }
    let strip: (String) -> String = { $0.hasPrefix("www.") ? String($0.dropFirst(4)) : $0 }
    let (a, b) = (strip(target), strip(page))
    return !(a == b || a.hasSuffix(".\(b)") || b.hasSuffix(".\(a)"))
  }

  /// Offers the page on screen to the user's other Apple devices (C14); a private page, a hidden tab or no page
  /// offers nothing.
  func updateHandoff() {
    guard isActive, !isPrivate, let url = webView.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
      handoff?.invalidate()
      handoff = nil
      return
    }
    if handoff == nil { handoff = NSUserActivity(activityType: NSUserActivityTypeBrowsingWeb) }
    guard let handoff else { return }
    if handoff.webpageURL != url {
      handoff.webpageURL = url
      handoff.title = webView.title
    }
    handoff.becomeCurrent()
  }

  /// Reports every element whose load failed (an image, a script, a frame, a stylesheet), from every frame, in Bay's
  /// isolated world: DOM events reach every world, the page's own scripts can't see this one.
  static let failedLoadScript = """
    (() => {
      const kinds = { IMG: "image", SCRIPT: "script", IFRAME: "subdocument", LINK: "stylesheet", VIDEO: "media", AUDIO: "media", SOURCE: "media" };
      window.addEventListener("error", (event) => {
        const node = event.target;
        if (!node || node === window || !node.tagName) return;
        const url = node.currentSrc || node.src || node.href;
        if (!url) return;
        try { window.webkit.messageHandlers.bayBlocked.postMessage(JSON.stringify({ url: String(url), type: kinds[node.tagName] || "other" })); } catch (e) {}
      }, true);
    })();
    """

  /// A failed load the filter lists account for is one the blocker stopped (C2); each is counted once per page.
  func receiveBlocked(_ message: WKScriptMessage) {
    guard
      let text = message.body as? String,
      let object = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
      let address = object["url"] as? String,
      let page = webView.url,
      BayContentBlocker.shared.isBlocking(page),
      !blockedRequests.contains(address),
      BayContentBlocker.shared.blocks(address, source: page.absoluteString, type: object["type"] as? String ?? "other")
    else { return }
    blockedRequests.insert(address)
    emit(.blockedCount(blockedRequests.count))
  }

  // Bay's swipe: anywhere on the page, and past the first and last page of the tab's history at the edges. WebKit's
  // own edge swipe still moves through the history where there is one.

  override public func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
    guard recognizer === swipePan, let pan = recognizer as? UIPanGestureRecognizer else {
      return super.gestureRecognizerShouldBegin(recognizer)
    }
    let velocity = pan.velocity(in: webView)
    guard swipeMode != .off, abs(velocity.x) > abs(velocity.y) * 2 else { return false }
    let start = pan.location(in: webView).x
    let width = webView.bounds.width
    let rightwards = velocity.x > 0
    let fromEdge = rightwards ? start < 24 : start > width - 24
    // At the edges, WebKit's own swipe takes over wherever there is a page to go to.
    if fromEdge { return rightwards ? !webView.canGoBack : !webView.canGoForward }
    return swipeMode == .anywhere
  }

  public func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    recognizer === swipePan && other === webView.scrollView.panGestureRecognizer
  }

  @objc func swipe(_ pan: UIPanGestureRecognizer) {
    let width = max(webView.bounds.width, 1)
    let translation = pan.translation(in: self).x
    let back = translation > 0
    let possible = back ? webView.canGoBack : webView.canGoForward
    switch pan.state {
    case .changed:
      // The page follows the finger, holding back where the swipe would leave the tab (or do nothing) rather than
      // move through its history.
      webView.transform = CGAffineTransform(translationX: possible ? translation : translation * 0.3, y: 0)
    case .ended, .cancelled, .failed:
      let velocity = pan.velocity(in: self).x
      let far = abs(translation) > width * 0.35
      let flicked = abs(translation) > 30 && abs(velocity) > 500 && translation * velocity > 0
      let committed = pan.state == .ended && (far || flicked)
      guard committed else {
        UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0) { self.webView.transform = .identity }
        return
      }
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
      if possible {
        UIView.animate(withDuration: 0.18, animations: {
          self.webView.transform = CGAffineTransform(translationX: back ? width : -width, y: 0)
          self.webView.alpha = 0
        }, completion: { _ in
          _ = back ? self.webView.goBack() : self.webView.goForward()
          self.webView.transform = .identity
          UIView.animate(withDuration: 0.2) { self.webView.alpha = 1 }
        })
      } else {
        UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0) { self.webView.transform = .identity }
        emit(.swipedPast(back ? .firstPage : .lastPage))
      }
    default:
      break
    }
  }
}

private final class BayBlockedMessageProxy: NSObject, WKScriptMessageHandler {
  weak var view: EngineView?

  init(view: EngineView) {
    self.view = view
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    view?.receiveBlocked(message)
  }
}
