import Foundation

// Addresses and local cards from a Chromium profile's `Web Data`, read by the shared reader (bay-import's secrets).
// Server (masked) cards live in other tables and are never read.
public enum ChromiumAutofill {
  public struct Outcome {
    public var addresses: [ImportedAddress]
    public var cards: [ImportedCard]
    /// Cards whose number didn't decrypt to 12–19 digits.
    public var undecryptable: Int
    /// Cards present but not read because no key was given.
    public var lockedCards: Int
  }

  public static func load(profile: URL, key: Data?, cancellation: Cancellation = .init()) throws -> Outcome {
    struct Answer: Decodable {
      struct Card: Decodable {
        var name: String?
        var number: SharedReaders.Secrets.Reference
        var expMonth: Int?
        var expYear: Int?
        var nickname: String?
      }

      var addresses: [ImportedAddress]
      var cards: [Card]
      var blocked: Int
      var locked: Int
    }
    var request: [String: Any] = ["reader": "chromiumAutofill", "profile": profile.path, "unsealedIsPlain": true]
    if let key { request["key"] = SharedReaders.hex(key) }
    let secrets = SharedReaders.Secrets()
    defer { secrets.wipe() }
    let answer = try SharedReaders.read(request, as: Answer.self, cancellation: cancellation, secrets: secrets)
    let cards = answer.cards.map {
      ImportedCard(name: $0.name, number: secrets.take($0.number), expMonth: $0.expMonth, expYear: $0.expYear,
                   nickname: $0.nickname)
    }
    return Outcome(addresses: answer.addresses, cards: cards, undecryptable: answer.blocked, lockedCards: answer.locked)
  }

  static func nonEmpty(_ s: String?) -> String? {
    guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
    return t
  }
}
