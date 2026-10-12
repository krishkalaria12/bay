import Foundation

@main
struct PrepareFirefox {
  static func main() throws {
    let arguments = CommandLine.arguments
    guard arguments.count == 4 else {
      throw ImportError.unsupported("Expected source profile, add-on ID and destination directory")
    }
    let profile = URL(fileURLWithPath: arguments[1], isDirectory: true)
    let path = try FirefoxExtensions.prepare(profile: profile, id: arguments[2],
                                              directory: URL(fileURLWithPath: arguments[3], isDirectory: true))
    let output: [String: Any] = ["path": path.path, "id": FirefoxExtensions.destinationId(arguments[2])]
    print(String(decoding: try JSONSerialization.data(withJSONObject: output), as: UTF8.self))
  }
}
