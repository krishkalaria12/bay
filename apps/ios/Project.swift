import ProjectDescription

// Bay for iPhone. `tuist generate` writes Bay.xcworkspace from this file; the workspace isn't checked in.
// Debug builds install as `…mobile.native` so they sit beside the Expo app on a device; Release keeps the store ID
// the Expo app ships under, so the native app installs over it and takes its data (docs/mobile-native-plan.html §9).

let bundleId = "in.krishkalaria.bay.mobile"
let deploymentTargets: DeploymentTargets = .iOS("15.0")
let core = "../../packages/mobile-core"

let baseSettings: SettingsDictionary = [
  "SWIFT_VERSION": "6.0",
  "SWIFT_STRICT_CONCURRENCY": "complete",
  "ENABLE_USER_SCRIPT_SANDBOXING": "NO",
  "TARGETED_DEVICE_FAMILY": "1",
  // The core is built for Apple silicon simulators only.
  "EXCLUDED_ARCHS[sdk=iphonesimulator*]": "x86_64",
  // UniFFI's C module, which BayCore imports and every target importing BayCore must see.
  "SWIFT_INCLUDE_PATHS": "$(SRCROOT)/../../packages/mobile-core/apple/include",
]

let project = Project(
  name: "Bay",
  options: .options(automaticSchemesOptions: .disabled, developmentRegion: "en"),
  settings: .settings(base: baseSettings),
  targets: [
    .target(
      name: "Bay",
      destinations: [.iPhone],
      product: .app,
      bundleId: bundleId,
      deploymentTargets: deploymentTargets,
      infoPlist: .extendingDefault(with: [
        "CFBundleDisplayName": "Bay",
        "CFBundleShortVersionString": "$(MARKETING_VERSION)",
        "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
        "UILaunchScreen": ["UIColorName": "", "UIImageRespectsSafeAreaInsets": true],
        "UISupportedInterfaceOrientations": ["UIInterfaceOrientationPortrait"],
        "ITSAppUsesNonExemptEncryption": false,
      ]),
      sources: ["Bay/Sources/**"],
      resources: ["Bay/Resources/**"],
      dependencies: [.target(name: "BayCore")],
      settings: .settings(
        base: [
          "MARKETING_VERSION": "1.0.0",
          "CURRENT_PROJECT_VERSION": "1",
          "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon",
        ],
        configurations: [
          .debug(name: "Debug", settings: ["PRODUCT_BUNDLE_IDENTIFIER": "\(bundleId).native"]),
          .release(name: "Release"),
        ]
      )
    ),
    // The Rust core's generated Swift API over its static library (packages/mobile-core). The script rebuilds both
    // before the target compiles; with nothing changed in Rust it finishes in about a second.
    .target(
      name: "BayCore",
      destinations: [.iPhone],
      product: .framework,
      bundleId: "\(bundleId).core",
      deploymentTargets: deploymentTargets,
      sources: ["\(core)/apple/Sources/BayCore.swift"],
      scripts: [
        .pre(
          script: "\"$SRCROOT/\(core)/scripts/build-ios.sh\"",
          name: "Build the Rust core",
          // Declared so Xcode compiles and links what the script has just written.
          outputPaths: [
            "$(SRCROOT)/\(core)/apple/Sources/BayCore.swift",
            "$(SRCROOT)/\(core)/apple/include/BayCoreFFI/BayCoreFFI.h",
            "$(SRCROOT)/\(core)/apple/lib/$(PLATFORM_NAME)/libbay_core.a",
          ],
          basedOnDependencyAnalysis: false
        ),
      ],
      settings: .settings(base: [
        "LIBRARY_SEARCH_PATHS": "$(SRCROOT)/\(core)/apple/lib/$(PLATFORM_NAME)",
        "OTHER_LDFLAGS": "-lbay_core",
        // UniFFI's generated file predates Swift 6's checks.
        "SWIFT_VERSION": "5.0",
        "SWIFT_STRICT_CONCURRENCY": "minimal",
      ])
    ),
  ],
  schemes: [
    .scheme(
      name: "Bay",
      buildAction: .buildAction(targets: ["Bay"]),
      runAction: .runAction(configuration: .debug, executable: "Bay"),
      archiveAction: .archiveAction(configuration: .release)
    ),
  ]
)
