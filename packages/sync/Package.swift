// swift-tools-version:5.9
import Foundation
import PackageDescription

// Bay's desktop Rust library, built by `cargo build -p bay-desktop` in packages/rust (scripts/test-native.mjs does).
let rustLibrary = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  .appendingPathComponent("../rust/target/debug").standardizedFileURL.path

let package = Package(
  name: "BaySyncCore",
  platforms: [.macOS(.v14)],
  products: [.library(name: "BaySyncCore", targets: ["BaySyncCore"])],
  targets: [
    // bay-sync's C ABI, from Bay's desktop Rust library.
    .systemLibrary(name: "BaySyncFFI", path: "ffi"),
    .target(
      name: "BaySyncCore",
      dependencies: ["BaySyncFFI"],
      path: "ios/Core",
      linkerSettings: [.unsafeFlags(["-L\(rustLibrary)", "-lbay_desktop"])]
    ),
    .testTarget(name: "BaySyncCoreTests", dependencies: ["BaySyncCore"], path: "tests"),
  ]
)
