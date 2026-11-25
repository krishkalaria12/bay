import BaySyncFFI
import Foundation

/// A chain's keys and the sync file format, from bay-sync (packages/rust/bay-sync), which Windows and Linux share.
/// Immutable once made, so any thread may use one.
public final class SyncKeys: @unchecked Sendable {
  public enum Failure: Error, Equatable {
    case format
    case authentication
  }

  private let keys: OpaquePointer

  public init(entropy: Data) {
    precondition(entropy.count == 32, "a chain's key is 32 bytes")
    keys = entropy.withUnsafeBytes { bay_sync_keys_new($0.bindMemory(to: UInt8.self).baseAddress)! }
  }

  deinit { bay_sync_keys_free(keys) }

  public var chainTag: String { Self.string(bay_sync_chain_tag(keys)) }

  public func scopeTag(_ scope: String) -> String { Self.string(bay_sync_scope_tag(keys, scope)) }

  public func seal(_ payload: Data, scopeTag: String, fileId: String) throws -> Data {
    var length = 0
    let sealed = payload.withUnsafeBytes { bytes in
      bay_sync_seal(keys, bytes.bindMemory(to: UInt8.self).baseAddress, bytes.count, scopeTag, fileId, &length)
    }
    defer { bay_sync_bytes_free(sealed, length) }
    return Data(bytes: sealed!, count: length)
  }

  public func open(_ file: Data, scopeTag: String, fileId: String) throws -> Data {
    var payload: UnsafeMutablePointer<UInt8>?
    var length = 0
    let status = file.withUnsafeBytes { bytes in
      bay_sync_open(keys, bytes.bindMemory(to: UInt8.self).baseAddress, bytes.count, scopeTag, fileId, &payload, &length)
    }
    switch status {
    case 0:
      defer { bay_sync_secret_free(payload, length) }
      return length == 0 ? Data() : Data(bytes: payload!, count: length)
    case 1: throw Failure.format
    default: throw Failure.authentication
    }
  }

  public static func newFileId() -> String { string(bay_sync_new_file_id()) }

  static func string(_ text: UnsafeMutablePointer<CChar>?) -> String {
    defer { bay_sync_string_free(text) }
    return text.map { String(cString: $0) } ?? ""
  }
}

enum Base32 {
  /// A tag: 16 bytes in base32, as every chain, scope and file name is.
  static func isTag(_ name: String) -> Bool { bay_sync_is_tag(name) }
}
