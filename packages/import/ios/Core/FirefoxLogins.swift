import Foundation

/// Firefox's (and Zen's) saved logins, key4.db opened without NSS: the shared reader (bay-import's firefox_logins),
/// the same one Windows and Linux run.
public enum FirefoxLogins {
  public static func logins(profile: URL, primaryPassword: String = "", cancellation: Cancellation = .init()) throws -> [Credential] {
    try SharedReaders.read(["reader": "firefoxLogins", "profile": profile.path, "primaryPassword": primaryPassword],
                           as: [Credential].self, cancellation: cancellation)
  }
}
