// swift-tools-version:5.9
// Builds the sync core (ios/Core: phrase, keys, sealed files, the folder) on its own so it
// can be tested with `swift test`: no app, no CocoaPods, no Expo. The pod compiles the same files.
import PackageDescription

let package = Package(
  name: "BaySyncCore",
  platforms: [.macOS(.v14)],
  products: [.library(name: "BaySyncCore", targets: ["BaySyncCore"])],
  targets: [
    .target(name: "BaySyncCore", path: "ios/Core"),
    .testTarget(name: "BaySyncCoreTests", dependencies: ["BaySyncCore"], path: "tests"),
  ]
)
