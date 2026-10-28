// Verifies a Sparkle EdDSA signature: ed25519-verify <file> <base64 signature> <base64 public key>; exits 0 if valid.
import CryptoKit
import Foundation

let args = CommandLine.arguments
guard args.count == 4, let data = FileManager.default.contents(atPath: args[1]),
  let signature = Data(base64Encoded: args[2]), let raw = Data(base64Encoded: args[3]),
  let key = try? Curve25519.Signing.PublicKey(rawRepresentation: raw)
else {
  FileHandle.standardError.write("usage: ed25519-verify <file> <base64 signature> <base64 public key>\n".data(using: .utf8)!)
  exit(2)
}
exit(key.isValidSignature(signature, for: data) ? 0 : 1)
