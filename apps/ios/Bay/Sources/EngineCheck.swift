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
  /// What the page's media last reported.
  @Published private(set) var media: MediaReport?
  private var timing = initialTiming()

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
      // The media watcher goes on each new document, as the browser screen will run it.
      let plan = scriptsFor(timing: timing, state: NavigationReport(url: next.url, progress: next.progress, isLoading: next.isLoading), hasRules: false)
      timing = plan.timing
      if plan.watchMedia { run(.watchMedia) }
    case .failure(let error): failure = error
    case .blockedCount(let count): blocked = count
    case .pageMessage(let message):
      lastMessage = message
      if let report = parseMediaMessage(message: message) {
        media = report
        // The lock screen and Control Center show it, and their buttons come back through `control`.
        Engine.setMediaSession(title: report.title, site: URL(string: state.url)?.host ?? "", playing: report.playing)
      }
    case .pageRequest(let request):
      // The debug screen has no sheet: it turns every request down so the page doesn't wait.
      view.answerPageRequest(id: request.id, accepted: false, value: nil, username: nil, password: nil)
    default: break
    }
  }

  /// What the system's media controls asked for, done by the page's own media.
  func control(_ action: MediaControl) {
    switch action {
    case .toggle: run(.toggleMedia)
    case .stop: run(.pauseMedia)
    case .skipForward: run(.seekMedia, args: ["seconds": 10])
    case .skipBackward: run(.seekMedia, args: ["seconds": -10])
    }
  }

  func close() {
    media = nil
    Engine.setMediaSession(title: nil, site: "", playing: false)
  }

  private func run(_ script: PageScript, args: [String: Any]? = nil) {
    Task { _ = try? await view.runScript(script, args: args) }
  }
}

/// A debug screen for the engine host (plan N3): opens an address, moves through history, runs a page script, blocks
/// with a small test list, downloads, and shows the page's media on the lock screen, to prove the engine works without
/// Expo before the browser screen lands (N4).
struct EngineCheckView: View {
  @StateObject private var control = EngineControl()
  @EnvironmentObject private var model: AppModel
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
        if let media = control.media {
          HStack {
            Text(verbatim: "Media: \(media.playing ? "playing" : "paused") · \(media.title)").accessibilityIdentifier("engine-media")
            Button(media.playing ? "Pause" : "Play") { control.control(.toggle) }.accessibilityIdentifier("engine-media-toggle")
          }
        }
        if let download = model.downloads.first {
          HStack {
            Text(verbatim: "Download: \(download.filename) · \(download.state) · \(download.received)/\(download.total)")
              .accessibilityIdentifier("engine-download")
            if let path = download.path {
              Button("Open") {
                do {
                  try Engine.openDownload(path)
                } catch {
                  scriptResult = error.localizedDescription
                }
              }
              .accessibilityIdentifier("engine-download-open")
            }
          }
        }
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
    .onAppear {
      model.mediaControl = { [weak control] action in control?.control(action) }
      if control.state.url.isEmpty { go() }
    }
    .onDisappear {
      model.mediaControl = nil
      control.close()
    }
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
