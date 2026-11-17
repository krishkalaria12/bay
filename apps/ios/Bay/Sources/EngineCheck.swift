import BayCore
import BayEngine
import SwiftUI

/// A page view in SwiftUI. The view is made once and kept; navigation goes through `EngineControl`.
struct EngineHost: UIViewRepresentable {
  let control: EngineControl

  func makeUIView(context: Context) -> EngineView {
    control.view
  }

  func updateUIView(_ view: EngineView, context: Context) {}
}

/// Owns one `EngineView` and publishes what it reports, for SwiftUI.
@MainActor
final class EngineControl: ObservableObject {
  let view = EngineView()
  @Published private(set) var state = NavigationState.empty
  @Published private(set) var failure: NavigationFailure?
  @Published private(set) var blocked = 0
  @Published private(set) var lastMessage: String?

  init() {
    view.stateKey = "engine-check"
    view.onEvent = { [weak self] event in
      // EngineView reports on the main thread.
      MainActor.assumeIsolated { self?.receive(event) }
    }
  }

  private func receive(_ event: EngineEvent) {
    switch event {
    case .navigation(let next):
      state = next
      if next.isLoading { failure = nil }
    case .failure(let error): failure = error
    case .blockedCount(let count): blocked = count
    case .pageMessage(let message): lastMessage = message
    case .pageRequest(let request):
      // The debug screen has no sheet: it turns every request down so the page doesn't wait.
      view.answerPageRequest(id: request.id, accepted: false, value: nil, username: nil, password: nil)
    default: break
    }
  }
}

/// A debug screen for the engine host (plan N3): opens an address, moves through history, runs a page script and
/// blocks with a small test list, to prove the engine works without Expo before the browser screen lands (N4).
struct EngineCheckView: View {
  @StateObject private var control = EngineControl()
  @Environment(\.dismiss) private var dismiss
  @State private var address = "https://www.bbc.com/news"
  @State private var scriptResult = ""
  @State private var blocking = "off"

  var body: some View {
    VStack(spacing: 8) {
      HStack {
        Button("Close") { dismiss() }.accessibilityIdentifier("engine-close")
        TextField("Address", text: $address)
          .textFieldStyle(.roundedBorder)
          .textInputAutocapitalization(.never)
          .disableAutocorrection(true)
          .onSubmit(go)
          .accessibilityIdentifier("engine-address")
        Button("Go", action: go).accessibilityIdentifier("engine-go")
      }
      HStack(spacing: 16) {
        Button("Back") { control.view.goBack() }.disabled(!control.state.canGoBack).accessibilityIdentifier("engine-back")
        Button("Forward") { control.view.goForward() }.disabled(!control.state.canGoForward)
        Button("Reload") { control.view.reload() }.accessibilityIdentifier("engine-reload")
        Button("Title") { runScript() }.accessibilityIdentifier("engine-script")
        Button("Block") { block() }.accessibilityIdentifier("engine-block")
      }
      .font(.footnote)
      Group {
        Text(verbatim: control.state.isLoading
          ? "Loading \(Int(control.state.progress * 100))%"
          : (control.state.title.isEmpty ? control.state.url : control.state.title))
          .accessibilityIdentifier("engine-state")
        Text(verbatim: "Blocking: \(blocking) · blocked \(control.blocked)").accessibilityIdentifier("engine-blocked")
        if !scriptResult.isEmpty { Text(verbatim: "Script: \(scriptResult)").accessibilityIdentifier("engine-script-result") }
        if let failure = control.failure {
          Text(verbatim: "\(failure.code): \(failure.message)").foregroundStyle(.red).accessibilityIdentifier("engine-failure")
        }
      }
      .font(.caption)
      .lineLimit(1)
      .frame(maxWidth: .infinity, alignment: .leading)
      EngineHost(control: control)
    }
    .padding(.horizontal)
    .onAppear { if control.state.url.isEmpty { go() } }
  }

  private func go() {
    let typed = address.trimmingCharacters(in: .whitespaces)
    let url = typed.contains("://") ? typed : "https://\(typed)"
    try? control.view.load(url)
  }

  private func runScript() {
    Task {
      scriptResult = (try? await control.view.evaluate("return document.title")) ?? "failed"
    }
  }

  /// A few ad and tracker hosts, written to a file and compiled into WebKit rules by the core's blocker.
  private func block() {
    blocking = "compiling"
    let list = """
      ||doubleclick.net^
      ||googlesyndication.com^
      ||googletagmanager.com^
      ||google-analytics.com^
      ||scorecardresearch.com^
      ||chartbeat.com^
      ||chartbeat.net^
      ||optimizely.com^
      """
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("engine-check-list.txt")
    Task {
      do {
        try list.write(to: file, atomically: true, encoding: .utf8)
        let rules = try await Engine.setContentBlocking(lists: [file.absoluteString], version: "engine-check-1")
        blocking = "\(rules) rules"
        control.view.reload()
      } catch {
        blocking = "failed: \(error.localizedDescription)"
      }
    }
  }
}
