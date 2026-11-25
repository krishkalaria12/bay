import CommonCrypto
import Foundation
import Security

/// The key Chromium seals values with on macOS, from its Safe Storage secret; the shared readers open them.
public enum ChromiumCrypto {
  static let salt = Data("saltysalt".utf8)
  static let rounds: UInt32 = 1003

  public static func deriveKey(secret: Data) -> Data {
    var key = Data(count: kCCKeySizeAES128)
    let status = key.withUnsafeMutableBytes { out in
      secret.withUnsafeBytes { secret in
        salt.withUnsafeBytes { salt in
          CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),
                               secret.bindMemory(to: Int8.self).baseAddress, secret.count,
                               salt.bindMemory(to: UInt8.self).baseAddress, salt.count,
                               CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1), rounds,
                               out.bindMemory(to: UInt8.self).baseAddress, kCCKeySizeAES128)
        }
      }
    }
    return status == kCCSuccess ? key : Data()
  }
}

public enum SafeStorageKeychain {
  // Call only after explicit unlock consent; Keychain access shows a system prompt.
  public static func secret(service: String, account: String) throws -> Data {
    for query in [account as String?, nil] {
      var q: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
      ]
      if let query { q[kSecAttrAccount as String] = query }
      var item: CFTypeRef?
      let status = SecItemCopyMatching(q as CFDictionary, &item)
      switch status {
      case errSecSuccess:
        guard let data = item as? Data, !data.isEmpty else { throw ImportError.locked("\(service) is empty") }
        return data
      case errSecItemNotFound:
        continue
      case errSecUserCanceled, errSecAuthFailed, errSecInteractionNotAllowed:
        throw ImportError.locked("Access to \(service) was denied")
      default:
        throw ImportError.locked("Keychain error \(status) reading \(service)")
      }
    }
    throw ImportError.notFound("No \(service) item in the Keychain")
  }
}
