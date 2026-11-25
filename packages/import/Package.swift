// swift-tools-version:5.9
import Foundation
import PackageDescription

// Bay's desktop Rust library, built by `cargo build -p bay-desktop` in packages/rust (scripts/test-native.mjs does).
let rustLibrary = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  .appendingPathComponent("../rust/target/debug").standardizedFileURL.path

let package = Package(
  name: "BayImportCore",
  platforms: [.macOS(.v14)],
  products: [.library(name: "BayImportCore", targets: ["BayImportCore"])],
  targets: [
    // bay-import's C ABI: the readers the desktops share.
    .systemLibrary(name: "BayImportFFI", path: "ffi"),
    .target(
      name: "BayImportCore",
      dependencies: ["BayImportFFI"],
      path: "ios/Core",
      linkerSettings: [.linkedLibrary("sqlite3"), .unsafeFlags(["-L\(rustLibrary)", "-lbay_desktop"])]
    ),
    .testTarget(
      name: "BayImportCoreTests",
      dependencies: ["BayImportCore"],
      path: "tests"
    ),
  ]
)
