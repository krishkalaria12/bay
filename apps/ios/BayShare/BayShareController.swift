// Share extension (B14): other apps show "Bay" in their share sheet; opening it reads the shared web address and
// hands it to Bay through its own scheme as `bay://share?url=…`, which the app answers as any incoming link (B9).
// One label shows the hands-off moment: the sheet closes as soon as Bay is asked to open.

import UIKit
import UniformTypeIdentifiers

final class BayShareController: UIViewController {
  override func viewDidLoad() {
    super.viewDidLoad()

    view.backgroundColor = .systemGroupedBackground
    let label = UILabel()
    label.text = "Opening in Bay…"
    label.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(label)
    NSLayoutConstraint.activate([
      label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])

    Self.handoff(self.extensionContext, from: self)
  }

  /** Reads the web item the user shared, then opens Bay with it and closes the sheet. */
  private static func handoff(_ context: NSExtensionContext?, from view: UIViewController) {
    let close = {
      context?.completeRequest(returningItems: [], completionHandler: nil)
    }
    let providers = (context?.inputItems ?? []).compactMap { $0 as? NSExtensionItem }.flatMap { $0.attachments ?? [] }
    let shared = providers.first { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }

    if shared == nil {
      close()
      return
    }

    shared!.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { value, _ in
      let address: URL? = switch value {
      case let url as URL: url
      case let string as String: URL(string: string)
      default: nil
      };

      if let address {
        Self.open(address, from: view)
      }
      close()
    }
  }

  /** Opens the containing app from an extension, which UIApplication.open refuses to do: the responder chain reaches
     the UIApplication behind it. The address travels as `bay://share?url=…` (B14), which the app answers as any
     incoming link (B9); images and other non-page shares stay out, matching `incomingLink`. */
  private static func open(_ url: URL, from view: UIViewController) {
    guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
      return
    }

    var link = URLComponents()
    link.scheme = "bay"
    link.host = "share"
    link.queryItems = [URLQueryItem(name: "url", value: url.absoluteString)]

    var responder: UIResponder? = view

    while responder != nil {
      if responder!.responds(to: Selector(("openURL:"))) {
        responder!.perform(Selector(("openURL:")), with: link.url)
        break
      }
      responder = responder!.next
    }
  }
}
