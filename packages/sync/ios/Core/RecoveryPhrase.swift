import BaySyncFFI
import Foundation

/// The recovery phrase: a chain's 32 bytes as 24 BIP-39 English words, from bay-sync (packages/rust/bay-sync), which
/// Windows and Linux share. A word may be typed by its first four letters or more.
public enum RecoveryPhrase {
  public static let wordCount = 24

  public enum Problem: Error, Equatable {
    case wordCount(Int)
    case unknownWord(String)
    case checksum
  }

  public static func generateEntropy() -> Data {
    var bytes = Data(count: 32)
    bytes.withUnsafeMutableBytes { bay_sync_random_entropy($0.bindMemory(to: UInt8.self).baseAddress) }
    return bytes
  }

  public static func words(for entropy: Data) -> [String] {
    precondition(entropy.count == 32)
    let phrase = entropy.withUnsafeBytes { SyncKeys.string(bay_sync_phrase_words($0.bindMemory(to: UInt8.self).baseAddress)) }
    return phrase.split(separator: " ").map(String.init)
  }

  public static func entropy(from text: String) throws -> Data {
    var entropy = Data(count: 32)
    var detail: UnsafeMutablePointer<CChar>?
    let status = entropy.withUnsafeMutableBytes { bay_sync_phrase_entropy(text, $0.bindMemory(to: UInt8.self).baseAddress, &detail) }
    let what = SyncKeys.string(detail)
    switch status {
    case 0: return entropy
    case 1: throw Problem.wordCount(Int(what) ?? 0)
    case 2: throw Problem.unknownWord(what)
    default: throw Problem.checksum
    }
  }
}
