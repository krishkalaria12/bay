import BayCore
import Combine
import Foundation

/// The app's words in the language Bay is showing, from the core's catalog (English behind missing keys). Changing
/// `locale` swaps every word at once, as picking a language in Settings does.
@MainActor
final class Strings: ObservableObject {
  @Published private(set) var locale: String
  private var table: [String: String]

  /// The language picked in Settings, kept across launches; none follows the phone.
  private static let savedKey = "bay.locale"

  /// The language picked in Settings, or nil while Bay follows the phone.
  var saved: String? { UserDefaults.standard.string(forKey: Self.savedKey) }

  /// The phone's own language, as Bay would show it.
  var device: String { matchLocale(tag: Foundation.Locale.preferredLanguages.first) }

  init(locale: String? = nil) {
    let chosen = locale ?? UserDefaults.standard.string(forKey: Self.savedKey) ?? matchLocale(tag: Foundation.Locale.preferredLanguages.first)
    self.locale = chosen
    table = catalog(locale: chosen)
  }

  /// Keeps `locale` for the next launches and shows it now; nil follows the phone again.
  func choose(_ locale: String?) {
    if let locale {
      UserDefaults.standard.set(locale, forKey: Self.savedKey)
    } else {
      UserDefaults.standard.removeObject(forKey: Self.savedKey)
    }
    show(locale ?? device)
  }

  func show(_ locale: String) {
    guard locale != self.locale else { return }
    self.locale = locale
    table = catalog(locale: locale)
  }

  /// The message under `key`, with `{name}` placeholders filled from `params`. An unknown key shows itself.
  func t(_ key: String, _ params: [String: String] = [:]) -> String {
    let template = table[key] ?? key
    if params.isEmpty { return template }
    // Filled in by the core, a call across the FFI: views ask for the same few each frame, so they're kept.
    let asked = ([template] + params.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }).joined(separator: "\u{0}")
    if let done = formatted[asked] { return done }
    let done = formatMessage(template: template, params: params)
    if formatted.count >= 512 { formatted.removeAll(keepingCapacity: true) }
    formatted[asked] = done
    return done
  }

  private var formatted: [String: String] = [:]

  /// A percentage written the language's way ("100%", "100 %").
  func percent(_ value: Int) -> String {
    t("format.percent", ["value": "\(value)"])
  }
}
