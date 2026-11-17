import BayCore
import SwiftUI

@main
struct BayApp: App {
  @StateObject private var strings = Strings()

  var body: some Scene {
    WindowGroup {
      VStack(spacing: 8) {
        Text("Bay")
          .font(.largeTitle.weight(.semibold))
        Text(strings.t("start.tapToSearch"))
          .accessibilityIdentifier("start-hint")
        Text("Core \(BayCore.version()) · \(strings.locale)")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("core-version")
      }
      .environmentObject(strings)
    }
  }
}
