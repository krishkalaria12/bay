import BayCore
import SwiftUI

@main
struct BayApp: App {
  var body: some Scene {
    WindowGroup {
      VStack(spacing: 8) {
        Text("Bay")
          .font(.largeTitle.weight(.semibold))
        Text("Core \(BayCore.version())")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("core-version")
      }
    }
  }
}
