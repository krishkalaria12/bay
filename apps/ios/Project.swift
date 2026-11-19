import ProjectDescription

// Bay for iPhone. `tuist generate` writes Bay.xcworkspace from this file; the workspace isn't checked in.
// Debug builds install as `…mobile.native` so they sit beside the Expo app on a device; Release keeps the store ID
// the Expo app ships under, so the native app installs over it and takes its data (docs/mobile-native-plan.html §9).

let bundleId = "in.krishkalaria.bay.mobile"
let deploymentTargets: DeploymentTargets = .iOS("15.0")
let core = "../../packages/mobile-core"
/// Bay as the default browser needs Apple's managed `com.apple.developer.web-browser` entitlement, granted on request:
/// builds made with TUIST_BAY_DEFAULT_BROWSER=1 claim it (and say so to the app); others sign as before.
let claimsBrowser = Environment.bayDefaultBrowser.getBoolean(default: false)

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

/// The app's bundle id per configuration (`…native` in Debug), which the extensions' ids extend.
let bundleIdSettings: [Configuration] = [
  .debug(name: "Debug", settings: ["BASE_BUNDLE_ID": "\(bundleId).native"]),
  .release(name: "Release", settings: ["BASE_BUNDLE_ID": "\(bundleId)"]),
]

/// The extensions build as their Expo targets did: Swift 5 mode, versions from the app's.
let extensionSettings: SettingsDictionary = [
  "SWIFT_VERSION": "5.0",
  "SWIFT_STRICT_CONCURRENCY": "minimal",
  "MARKETING_VERSION": "1.0.0",
  "CURRENT_PROJECT_VERSION": "1",
]

let project = Project(
  name: "Bay",
  options: .options(automaticSchemesOptions: .disabled, developmentRegion: "en"),
  settings: .settings(base: baseSettings, configurations: bundleIdSettings),
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
        "NSFaceIDUsageDescription": "Bay uses Face ID to unlock your private tabs.",
        // Downloads land in Documents/Downloads, which the Files app shows under Bay.
        "UIFileSharingEnabled": true,
        "LSSupportsOpeningDocumentsInPlace": true,
        // iOS 26 runs each download as a continued-processing task under this prefix.
        "BGTaskSchedulerPermittedIdentifiers": ["$(PRODUCT_BUNDLE_IDENTIFIER).download.*"],
        // Bay's own links (the share extension, widgets and quick actions open `bay://` commands), and the web
        // schemes it answers as a browser, which iOS reads for the default-browser offer.
        "CFBundleURLTypes": [["CFBundleURLName": "Bay", "CFBundleURLSchemes": ["bay", "http", "https"]]],
        "UIApplicationShortcutItems": [
          ["UIApplicationShortcutItemType": "$(PRODUCT_BUNDLE_IDENTIFIER).new-tab", "UIApplicationShortcutItemTitle": "New tab"],
          ["UIApplicationShortcutItemType": "$(PRODUCT_BUNDLE_IDENTIFIER).private-tab", "UIApplicationShortcutItemTitle": "Private tab"],
        ],
        // The import sheet asks which browsers the phone has by whether their schemes open.
        "LSApplicationQueriesSchemes": ["googlechrome", "firefox", "microsoft-edge-https", "brave", "ddgQuickLink"],
        // Whether this build may ask iOS if it's the default browser (DefaultBrowserStatus.swift).
        "BayCanBeDefaultBrowser": .boolean(claimsBrowser),
      ]),
      sources: ["Bay/Sources/**"],
      resources: ["Bay/Resources/**"],
      entitlements: claimsBrowser ? .dictionary(["com.apple.developer.web-browser": true]) : nil,
      dependencies: [
        .target(name: "BayCore"), .target(name: "BayDesign"), .target(name: "BayEngine"), .target(name: "BayShare"), .target(name: "BayWidgets"),
      ],
      settings: .settings(
        base: [
          "MARKETING_VERSION": "1.0.0",
          "CURRENT_PROJECT_VERSION": "1",
          "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon",
          // The icons Settings > Appearance can put on the home screen (AppIcons.swift), named as the Expo app named them.
          "ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES": "Navy Coral Noir Cobalt Bridge",
          "ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS": "YES",
        ],
        configurations: [
          .debug(name: "Debug", settings: ["PRODUCT_BUNDLE_IDENTIFIER": "\(bundleId).native"]),
          .release(name: "Release"),
        ]
      )
    ),
    // Share to Bay: a page shared from another app opens in Bay as `bay://share?url=…`.
    .target(
      name: "BayShare",
      destinations: [.iPhone],
      product: .appExtension,
      bundleId: "$(BASE_BUNDLE_ID).share",
      deploymentTargets: deploymentTargets,
      infoPlist: .extendingDefault(with: [
        "CFBundleDisplayName": "Bay",
        "CFBundleShortVersionString": "$(MARKETING_VERSION)",
        "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
        "NSExtension": [
          "NSExtensionPointIdentifier": "com.apple.share-services",
          // iOS reads the rule from the attributes only; outside them, the extension matches nothing and never shows.
          "NSExtensionAttributes": [
            "NSExtensionActivationRule": [
              "NSExtensionActivationSupportsText": true,
              "NSExtensionActivationSupportsWebURLWithMaxCount": 1,
            ],
          ],
          "NSExtensionPrincipalClass": "$(PRODUCT_MODULE_NAME).BayShareController",
        ],
      ]),
      sources: ["BayShare/**"],
      settings: .settings(base: extensionSettings)
    ),
    // The search widgets: each opens Bay at a `bay://` command. Their buttons use OpenURLIntent, from iOS 18; older
    // phones keep Bay without the widget.
    .target(
      name: "BayWidgets",
      destinations: [.iPhone],
      product: .appExtension,
      bundleId: "$(BASE_BUNDLE_ID).widgets",
      deploymentTargets: .iOS("18.0"),
      infoPlist: .extendingDefault(with: [
        "CFBundleDisplayName": "Bay",
        "CFBundleShortVersionString": "$(MARKETING_VERSION)",
        "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
        "NSExtension": ["NSExtensionPointIdentifier": "com.apple.widgetkit-extension"],
      ]),
      sources: ["BayWidget/**"],
      dependencies: [.sdk(name: "WidgetKit", type: .framework), .sdk(name: "SwiftUI", type: .framework)],
      settings: .settings(base: extensionSettings)
    ),
    // Bay's design system (plan D12): tokens and icons generated from packages/mobile-core/design, and the components
    // every screen is built from (text, icons, glass surfaces, buttons, switches, press feedback, haptics).
    .target(
      name: "BayDesign",
      destinations: [.iPhone],
      product: .framework,
      bundleId: "\(bundleId).design",
      deploymentTargets: deploymentTargets,
      sources: ["BayDesign/Sources/**"],
      dependencies: [.sdk(name: "SwiftUI", type: .framework)]
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
      resources: [
        // Scriptlet and $redirect stand-ins for the blocker (uBlock Origin's and Brave's resources).
        "../../packages/adblock/resources/resources.json",
        // Page scripts, one copy shared with the Expo app (D13).
        "../../packages/mobile-pagescripts/resources/pagescripts.json",
      ],
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
    // Accessibility audits of the main screens (XCUIApplication.performAccessibilityAudit, iOS 17+), run with the Bay
    // scheme's test action on a simulator.
    .target(
      name: "BayUITests",
      destinations: [.iPhone],
      product: .uiTests,
      bundleId: "\(bundleId).uitests",
      deploymentTargets: .iOS("17.0"),
      infoPlist: .default,
      sources: ["BayUITests/**"],
      dependencies: [.target(name: "Bay")]
    ),
  ],
  schemes: [
    .scheme(
      name: "Bay",
      buildAction: .buildAction(targets: ["Bay"]),
      testAction: .targets(["BayUITests"], configuration: .debug),
      runAction: .runAction(configuration: .debug, executable: "Bay"),
      archiveAction: .archiveAction(configuration: .release)
    ),
  ]
)
