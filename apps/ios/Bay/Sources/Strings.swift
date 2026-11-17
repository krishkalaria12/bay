import BayCore
import Combine
import Foundation

/// The app's words in the language Bay is showing, from the core's catalog (English behind missing keys). Changing
/// `locale` swaps every word at once, as picking a language in Settings does.
@MainActor
final class Strings: ObservableObject {
  @Published private(set) var locale: String
  private var table: [String: String]

  init(locale: String? = nil) {
    let chosen = locale ?? matchLocale(tag: Foundation.Locale.preferredLanguages.first)
    self.locale = chosen
    table = catalog(locale: chosen)
  }

  func show(_ locale: String) {
    guard locale != self.locale else { return }
    self.locale = locale
    table = catalog(locale: locale)
  }

  /// The message under `key`, with `{name}` placeholders filled from `params`. An unknown key shows itself.
  func t(_ key: String, _ params: [String: String] = [:]) -> String {
    let template = table[key] ?? key
    return params.isEmpty ? template : formatMessage(template: template, params: params)
  }
}
