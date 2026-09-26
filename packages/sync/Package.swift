// swift-tools-version:5.9
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
