import BayCore
import Foundation

/// The core's address helpers, remembered: views ask for the same site's host, name and short address on every update
/// (each card, row and icon), and each answer is a call across the FFI that allocates on both sides. The answers depend
/// only on the address. These shadow the core's functions of the same names for the whole app.
private final class Remembered: @unchecked Sendable {
  private let answers = NSCache<NSString, NSString>()
  private let compute: (String) -> String

  init(_ compute: @escaping (String) -> String) {
    self.compute = compute
    answers.countLimit = 1024
  }

  func callAsFunction(_ url: String) -> String {
    if let known = answers.object(forKey: url as NSString) { return known as String }
    let answer = compute(url)
    answers.setObject(answer as NSString, forKey: url as NSString)
    return answer
  }
}

private let hosts = Remembered { BayCore.hostOf(url: $0) }
private let shortAddresses = Remembered { BayCore.displayUrl(url: $0) }
private let names = Remembered { BayCore.siteName(url: $0) }

/// The address's host without "www.".
func hostOf(url: String) -> String { hosts(url) }

/// The address as the bar shows it.
func displayUrl(url: String) -> String { shortAddresses(url) }

/// The site's name for a list row.
func siteName(url: String) -> String { names(url) }
