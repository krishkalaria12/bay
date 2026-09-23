// swift-tools-version:5.9
// Builds the pure-Swift import core (ios/Core) on its own so the parsers can be tested with
// `swift test` — no app, no CocoaPods, no Expo. The pod compiles the same files.
import PackageDescription

let package = Package(
  name: "BayImportCore",
  platforms: [.macOS(.v14)],
  products: [.library(name: "BayImportCore", targets: ["BayImportCore"])],
  targets: [
    .target(name: "BayImportCore", path: "ios/Core", linkerSettings: [.linkedLibrary("sqlite3")]),
    .testTarget(
      name: "BayImportCoreTests",
      dependencies: ["BayImportCore"],
      path: "tests"
    ),
  ]
)
