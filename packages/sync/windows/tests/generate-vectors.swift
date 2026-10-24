// Run on macOS with SyncCrypto.swift to regenerate the shared CryptoKit fixture.
import Foundation
import CryptoKit
import Security
public enum RecoveryPhrase {
  public static func generateEntropy() -> Data {
    var bytes = Data(count: 32)
    _ = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
    return bytes
  }
}
@main struct Vectors {
  static func main() throws {
    let entropy = Data(0..<32), nonce = Data(0..<12)
    let keys = SyncKeys(entropy: entropy), scope = keys.scopeTag("p:default")
    let id = "abcdefghijklmnopqrstuvwxyz", payload = Data("{\"v\":1,\"label\":\"Mac ↔ Windows\"}".utf8)
    var plain = withUnsafeBytes(of: UInt32(payload.count).bigEndian) { Data($0) } + payload
    plain.append(Data(count: (1024 - plain.count % 1024) % 1024))
    let box = try AES.GCM.seal(plain, using: keys.fileKey, nonce: AES.GCM.Nonce(data: nonce), authenticating: SyncKeys.associatedData(chain: keys.chainTag, scope: scope, file: id))
    let file = SyncKeys.magic + nonce + box.ciphertext + box.tag
    func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
    let vector: [String: Any] = ["entropy": hex(entropy), "nonce": hex(nonce), "scope": "p:default", "scopeTag": scope, "chainTag": keys.chainTag, "fileId": id, "payload": String(decoding: payload, as: UTF8.self), "sealed": hex(file)]
    print(String(decoding: try JSONSerialization.data(withJSONObject: vector, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]), as: UTF8.self))
    let opened = try keys.open(file, scopeTag: scope, fileId: id)
    assert(opened == payload)
  }
}
