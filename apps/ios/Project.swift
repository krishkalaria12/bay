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
  // UniFFI's C module, which BayCore imports and every target importing BayCore must see, and the content blocker's
  // (BayAdblock), whose functions the core's library carries on iOS (plan D16).
  "SWIFT_INCLUDE_PATHS": "$(SRCROOT)/../../packages/mobile-core/apple/include $(SRCROOT)/../../packages/adblock/include",
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
        // Pages: plain http in web content only (the app's own requests keep ATS), media that keeps playing in the
        // background, and what pages and the engine may ask for, as the Expo app declares them.
        "NSAppTransportSecurity": ["NSAllowsArbitraryLoadsInWebContent": true],
        "UIBackgroundModes": ["audio"],
        "NSLocationWhenInUseUsageDescription": "Bay shares your location with sites you allow.",
        "NSCameraUsageDescription": "Bay lets sites you allow use the camera.",
        "NSMicrophoneUsageDescription": "Bay uses the microphone to search by voice, and for sites you allow.",
        "NSSpeechRecognitionUsageDescription": "Bay turns your words into a search on the device.",
        "NSPhotoLibraryAddUsageDescription": "Bay saves images you ask for to your photo library.",
        // Downloads land in Documents/Downloads, which the Files app shows under Bay.
        "UIFileSharingEnabled": true,
        "LSSupportsOpeningDocumentsInPlace": true,
        // iOS 26 runs each download as a continued-processing task under this prefix.
        "BGTaskSchedulerPermittedIdentifiers": ["$(PRODUCT_BUNDLE_IDENTIFIER).download.*"],
      ]),
      sources: ["Bay/Sources/**"],
      resources: ["Bay/Resources/**"],
      dependencies: [.target(name: "BayCore"), .target(name: "BayEngine")],
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
    // The page engine: WKWebView behind Bay's navigation policy, content blocking, downloads, media and voice, ported
    // from the Expo module (apps/mobile/modules/bay-engine). Swift 5 mode until it is moved to strict concurrency.
    .target(
      name: "BayEngine",
      destinations: [.iPhone],
      product: .framework,
      bundleId: "\(bundleId).engine",
      deploymentTargets: deploymentTargets,
      sources: ["BayEngine/Sources/**"],
      // Scriptlet and $redirect stand-ins for the blocker (uBlock Origin's and Brave's resources).
      resources: ["../../packages/adblock/resources/resources.json"],
      dependencies: [
        .target(name: "BayCore"),
        .sdk(name: "WebKit", type: .framework),
        .sdk(name: "QuickLook", type: .framework),
        .sdk(name: "BackgroundTasks", type: .framework),
        .sdk(name: "MediaPlayer", type: .framework),
        .sdk(name: "AVFoundation", type: .framework),
        .sdk(name: "UserNotifications", type: .framework),
        .sdk(name: "Speech", type: .framework),
        .sdk(name: "Photos", type: .framework),
      ],
      settings: .settings(base: [
        "SWIFT_VERSION": "5.0",
        "SWIFT_STRICT_CONCURRENCY": "minimal",
      ])
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
