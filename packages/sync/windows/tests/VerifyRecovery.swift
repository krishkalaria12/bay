// macOS verification: decode the portable C++ QR and compare all words with Swift.
import Foundation
import Vision
@main struct Verify {
 static func main() throws {
  let request = VNDetectBarcodesRequest()
  request.symbologies = [.qr]
  try VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[1])).perform([request])
  let expected = RecoveryPhrase.words(for: Data(0..<32)).joined(separator: " ")
  guard request.results?.first?.payloadStringValue == expected else {
   FileHandle.standardError.write(Data("QR did not decode to the Swift recovery phrase\n".utf8));exit(1)
  }
  print("QR decoder verified all 24 recovery words against Swift")
 }
}
