import Foundation

/// What a page view reports, as one stream per view (`EngineView.onEvent`). The Expo module sent these as separate
/// React events; here they are one typed enum the app switches over.
public enum EngineEvent {
  /// The address, title, progress, loading and history the view now has.
  case navigation(NavigationState)
  /// A main-frame load failed. Native certificate validation is never bypassed.
  case failure(NavigationFailure)
  /// The page scrolled, in points: at most every 50 ms, with a trailing update. Overscroll is clamped to zero.
  case scroll(offsetY: Double, deltaY: Double)
  /// A long press on a web link, which the app's own menu answers.
  case linkPress(LinkPress)
  /// A message a page script sent with `post(message)`, as JSON text.
  case pageMessage(String)
  /// A site asked something and waits: answer with `EngineView.answerPageRequest`.
  case pageRequest(PageRequest)
  /// A new window (`target=_blank`, `window.open`) that becomes a real tab, in this view's own session.
  case newWindow(url: String, isPrivate: Bool)
  /// A swipe back past the tab's first page, or forward past its last.
  case swipedPast(SwipeEnd)
  /// How many requests the blocker stopped on the page now showing.
  case blockedCount(Int)
}

public struct NavigationState: Equatable, Sendable {
  public var url: String
  public var title: String
  /// Estimated completion, between 0 and 1.
  public var progress: Double
  public var isLoading: Bool
  public var canGoBack: Bool
  public var canGoForward: Bool
  /// The tab's first navigation became a download, so it has no page to show.
  public var blank: Bool

  /// A view before its first page.
  public static let empty = NavigationState(
    url: "", title: "", progress: 0, isLoading: false, canGoBack: false, canGoForward: false, blank: false)
}

public struct NavigationFailure: Equatable, Sendable {
  public var url: String
  /// `<domain>:<code>`, or `renderer-terminated`.
  public var code: String
  public var message: String
}

public struct LinkPress: Equatable, Sendable {
  public var url: String
  /// The link's text when known; otherwise the address.
  public var title: String
  /// Where the press was, as fractions of the view; nil when WebKit doesn't say.
  public var x: Double?
  public var y: Double?
  /// A bare image rather than a link: `url` is the image's own address.
  public var image: Bool

  public init(url: String, title: String, x: Double?, y: Double?, image: Bool) {
    self.url = url
    self.title = title
    self.x = x
    self.y = y
    self.image = image
  }
}

public enum PageRequestKind: String, Sendable {
  case alert, confirm, prompt, auth, external, permission
}

/// A page's `alert`/`confirm`/`prompt`, the server's HTTP sign-in, a link to another app, or a device permission.
public struct PageRequest: Equatable, Sendable {
  public var id: String
  public var kind: PageRequestKind
  public var message: String
  /// The prompt's initial text.
  public var defaultValue: String?
  /// The server's realm, for a sign-in.
  public var realm: String?
  /// The address that belongs to another app (tel:, mailto:, maps, an app's own scheme).
  public var externalUrl: String?
  /// `camera`, `microphone` or `camera-microphone`.
  public var permission: String?
  /// The page address that asked.
  public var url: String
}

public enum SwipeEnd: Sendable {
  case firstPage, lastPage
}

/// What the system's media controls asked for.
public enum MediaControl: String, Sendable {
  case toggle, stop
  case skipForward = "skip-forward"
  case skipBackward = "skip-backward"
}

public enum EngineError: LocalizedError {
  case invalidAddress
  case pageScript(String)
  case downloadMissing
  case noWindow
  case imageAddress
  case imageFetch
  case photosDenied
  case photosSave

  public var errorDescription: String? {
    switch self {
    case .invalidAddress: return "Only HTTP and HTTPS addresses can be opened."
    case .pageScript(let reason): return reason
    case .downloadMissing: return "The file isn't there anymore."
    case .noWindow: return "Bay has no window to show the file in."
    case .imageAddress: return "Bay can only save web images."
    case .imageFetch: return "The image couldn't be downloaded."
    case .photosDenied: return "Bay needs Photos access to save images."
    case .photosSave: return "The image couldn't be saved."
    }
  }
}
