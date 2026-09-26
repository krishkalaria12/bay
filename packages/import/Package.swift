// swift-tools-version:5.9
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
