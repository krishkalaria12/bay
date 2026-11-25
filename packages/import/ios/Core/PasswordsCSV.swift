import Foundation

/// A password CSV export (Chrome, Firefox, Safari, Bitwarden and others), read by the shared reader (bay-import).
public enum PasswordsCSV {
  public static func parse(_ text: String) throws -> [Credential] {
    try SharedReaders.read(["reader": "passwordsCsv", "text": text], as: [Credential].self)
  }

  public static func load(_ url: URL) throws -> [Credential] {
    let data = try Data(contentsOf: url)
    guard let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) else {
      throw ImportError.unreadable("Couldn't read \(url.lastPathComponent)")
    }
    return try parse(text)
  }
}
