import Foundation

/// A Chromium profile's saved passwords and cookies, read by the shared readers (bay-import's secrets) with the key
/// macOS unlocked: the same readers Windows and Linux run with their own keys.
public enum ChromiumSecrets {
  public struct Outcome<T> {
    public var items: [T]
    public var undecryptable: Int
  }

  public static func logins(profile: URL, key: Data, cancellation: Cancellation = .init()) throws -> Outcome<Credential> {
    struct Answer: Decodable {
      var credentials: [Credential]
      var blocked: Int
    }
    // A password saved before Chromium encrypted anything is its plain text.
    let answer = try SharedReaders.read(
      ["reader": "chromiumLogins", "profile": profile.path, "key": SharedReaders.hex(key), "unsealedIsPlain": true],
      as: Answer.self, cancellation: cancellation)
    return Outcome(items: answer.credentials, undecryptable: answer.blocked)
  }

  public static func cookies(profile: URL, key: Data, cancellation: Cancellation = .init()) throws -> Outcome<Cookie> {
    try cookies(["profile": profile.path], key: key, cancellation: cancellation)
  }

  public static func cookies(database: URL, key: Data, cancellation: Cancellation = .init()) throws -> Outcome<Cookie> {
    try cookies(["database": database.path], key: key, cancellation: cancellation)
  }

  private static func cookies(_ source: [String: Any], key: Data, cancellation: Cancellation) throws -> Outcome<Cookie> {
    struct Answer: Decodable {
      var cookies: [SharedReaders.CookieAnswer]
      var blocked: Int
    }
    let secrets = SharedReaders.Secrets()
    defer { secrets.wipe() }
    let request = source.merging(["reader": "chromiumCookies", "key": SharedReaders.hex(key), "unsealedIsPlain": true]) { a, _ in a }
    let answer = try SharedReaders.read(request, as: Answer.self, cancellation: cancellation, secrets: secrets)
    return Outcome(items: answer.cookies.map { $0.cookie(secrets) }, undecryptable: answer.blocked)
  }
}
