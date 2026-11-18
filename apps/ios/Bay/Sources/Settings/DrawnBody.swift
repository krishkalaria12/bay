import BayCore
import BayDesign
import SwiftUI

extension PreferencesUpdate {
  /// An update that changes only the page zoom.
  static func textSize(_ value: Double) -> PreferencesUpdate {
    PreferencesUpdate(
      theme: nil, textSize: value, searchSuggestions: nil, skipAmp: nil, pullToRefresh: nil, startPageAfterHours: nil, youtube: nil,
      welcomed: nil, openSearchOnLaunch: nil, swipeToNavigate: nil, appLinks: nil)
  }
}

/// The page zoom's limits and step, as the store keeps them.
private enum TextSizeLimits {
  static let min = 80
  static let max = 200
  static let step = 10
}

/// What a page draws below its rows: the custom engine's field, the wallpapers, the page zoom, joining sync.
struct DrawnBody: View {
  @ObservedObject var settings: SettingsModel
  let page: SettingsPage

  var body: some View {
    switch page {
    case .wallpaper: WallpaperPicker(settings: settings)
    case .textSize: TextSizeBody(settings: settings)
    case .customEngine: CustomEngineBody(settings: settings)
    case .syncJoin: SyncJoinBody(settings: settings)
    case .syncPhrase: SyncPhraseBody(settings: settings)
    default: EmptyView()
    }
  }
}

/// Three columns of start-page previews, then the user's photo.
private struct WallpaperPicker: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var settings: SettingsModel

  private static let ids: [WallpaperId] = [.bay, .dusk, .forest, .plain, .photo]

  var body: some View {
    let current = app.preferences.wallpaper
    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Space.md), count: 3), spacing: Space.lg) {
      ForEach(Self.ids, id: \.self) { id in
        let selected = id == current
        let empty = id == .photo && app.preferences.wallpaperPhoto == nil
        let name = empty ? strings.t("settings.wallpaper.choose") : strings.t("settings.wallpapers.\(id)")
        Button {
          // Your photo needs the system photo picker, which comes with the onboarding's (N6).
          if id != .photo || !empty { app.dispatch(.wallpaper(id: id, photo: nil)) }
        } label: {
          VStack(spacing: Space.sm) {
            ZStack {
              if empty {
                BayIconView(.add, size: 28)
              } else {
                WallpaperView(id: id).ignoresSafeArea(edges: [])
              }
            }
            .frame(maxWidth: .infinity)
            .aspectRatio(0.62, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
            .overlay(
              RoundedRectangle(cornerRadius: Radius.tile, style: .continuous)
                .stroke(selected ? BayColor.accent : BayColor.foreground.opacity(0.1), lineWidth: selected ? 2 : 1))
            BayText(name, variant: .subhead, weight: selected ? .medium : nil, tone: selected ? .accent : .default)
          }
        }
        .buttonStyle(.pressFeedback)
        .accessibilityLabel(Text(verbatim: empty ? strings.t("settings.wallpaper.chooseLabel") : name))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("settings-wallpaper-\(id)")
      }
    }
  }
}

/// The page zoom: a preview at the zoom, smaller and larger, and back to 100%.
private struct TextSizeBody: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var settings: SettingsModel

  var body: some View {
    let value = Int(app.preferences.textSize)
    let scale = CGFloat(value) / 100
    VStack(spacing: Space.lg) {
      VStack(alignment: .leading, spacing: 4) {
        Text(verbatim: "example.com").font(.system(size: 13 * scale)).foregroundColor(BayColor.muted)
        Text(verbatim: strings.t("settings.zoom.previewTitle")).font(.system(size: 20 * scale, weight: .semibold))
        Text(verbatim: strings.t("settings.zoom.previewBody")).font(.system(size: 16 * scale))
      }
      .foregroundColor(BayColor.foreground)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(Space.lg)
      .background(BayColor.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
      HStack(spacing: Space.md) {
        step(-TextSizeLimits.step, label: strings.t("settings.zoom.out"), id: "text-size-smaller", size: 16, value: value)
        BayText("\(value)%", variant: .headline).frame(width: 64).accessibilityIdentifier("text-size-value")
        step(TextSizeLimits.step, label: strings.t("settings.zoom.in"), id: "text-size-larger", size: 26, value: value)
      }
      if value != 100 {
        RowGroup {
          ActionRow(strings.t("settings.zoom.reset"), testID: "text-size-reset") {
            app.dispatch(.preferences(update: .textSize(100)))
          }
        }
      }
    }
  }

  private func step(_ delta: Int, label: String, id: String, size: CGFloat, value: Int) -> some View {
    let next = min(TextSizeLimits.max, max(TextSizeLimits.min, value + delta))
    return Button {
      app.dispatch(.preferences(update: .textSize(Double(next))))
    } label: {
      BayIconView(.textSize, size: size).frame(maxWidth: .infinity).frame(height: 48)
        .background(BayColor.surface, in: Capsule())
    }
    .buttonStyle(.pressFeedback)
    .disabled(next == value)
    .opacity(next == value ? 0.35 : 1)
    .accessibilityLabel(Text(verbatim: label))
    .accessibilityIdentifier(id)
  }
}

/// The custom search engine's address: https with `%s` where the words go.
private struct CustomEngineBody: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var settings: SettingsModel
  @State private var url = ""

  var body: some View {
    let trimmed = url.trimmingCharacters(in: .whitespaces)
    let valid = trimmed.hasPrefix("https://") && trimmed.contains("%s")
    VStack(alignment: .leading, spacing: Space.sm) {
      TextField("https://example.com/search?q=%s", text: $url)
        .keyboardType(.URL)
        .textInputAutocapitalization(.never)
        .disableAutocorrection(true)
        .padding(.horizontal, Space.lg)
        .padding(.vertical, 12)
        .background(BayColor.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .accessibilityLabel(Text(verbatim: strings.t("settings.customEngine")))
        .accessibilityIdentifier("settings-custom-engine-url")
      BayText(strings.t("settings.customEngine.note"), variant: .footnote, tone: .muted).padding(.horizontal, Space.sm)
      RowGroup {
        ActionRow(strings.t("settings.customEngine.use"), testID: "settings-custom-engine-save", disabled: !valid) {
          app.dispatch(.searchEngine(id: "custom", customUrl: trimmed))
          settings.pop()
        }
      }
      .padding(.top, Space.sm)
    }
    .onAppear { url = app.preferences.customSearchUrl ?? "" }
  }
}

/// Joining sync by a code the computer shows: the phone asks every two seconds whether it has been let in.
private struct SyncJoinBody: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var settings: SettingsModel

  var body: some View {
    VStack(spacing: Space.section) {
      VStack(spacing: Space.md) {
        BayText(strings.t("sync.code.title"), variant: .subhead, tone: .muted).multilineTextAlignment(.center)
        switch app.syncView.pairing {
        case .waiting(let code, let digits):
          BayText(code, variant: .display).accessibilityIdentifier("sync-code")
          BayText(strings.t("sync.code.digits", ["digits": digits]), variant: .footnote, tone: .muted).accessibilityIdentifier("sync-code-digits")
        case .expired:
          BayText(strings.t("sync.code.expired"), tone: .muted).accessibilityIdentifier("sync-code-state")
        case .failed:
          BayText(strings.t("sync.code.failed"), tone: .danger).accessibilityIdentifier("sync-code-state")
        default:
          BayText(strings.t("sync.code.starting"), tone: .muted).accessibilityIdentifier("sync-code-state")
        }
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, Space.xl)
      .padding(.horizontal, Space.gutter)
      .background(BayColor.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
      if case .expired = app.syncView.pairing {
        RowGroup { ActionRow(strings.t("sync.code.again"), testID: "sync-code-again") { app.pair() } }
      } else if case .failed = app.syncView.pairing {
        RowGroup { ActionRow(strings.t("sync.code.again"), testID: "sync-code-again") { app.pair() } }
      }
      BayText(strings.t("sync.join.note"), variant: .footnote, tone: .muted).padding(.horizontal, Space.sm)
    }
    .onAppear { app.pair() }
    .onDisappear { app.cancelPairing() }
    // Joined: back to Sync, which now shows this phone among the devices.
    .onChange(of: app.syncView.status) { status in
      if status != .off { settings.pop() }
    }
  }
}

/// Joining sync with the recovery phrase.
private struct SyncPhraseBody: View {
  @EnvironmentObject private var strings: Strings
  @EnvironmentObject private var app: AppModel
  @ObservedObject var settings: SettingsModel
  @State private var text = ""
  @State private var problem: String?
  @State private var running = false

  var body: some View {
    VStack(alignment: .leading, spacing: Space.section) {
      TextEditor(text: $text)
        .frame(minHeight: 120)
        .textInputAutocapitalization(.never)
        .disableAutocorrection(true)
        .padding(Space.sm)
        .background(BayColor.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .accessibilityLabel(Text(verbatim: strings.t("settings.page.syncPhrase")))
        .accessibilityIdentifier("sync-phrase-field")
      if let problem {
        BayText(problem, variant: .footnote, tone: .danger).padding(.horizontal, Space.sm).accessibilityIdentifier("sync-phrase-problem")
      }
      VStack(alignment: .leading, spacing: 6) {
        RowGroup {
          ActionRow(strings.t("sync.phrase.join"), testID: "sync-phrase-join", disabled: running || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
            running = true
            Task {
              problem = await app.join(phrase: text)
              running = false
              if problem == nil { settings.pop() }
            }
          }
        }
        BayText(strings.t("sync.phrase.note"), variant: .footnote, tone: .muted).padding(.horizontal, Space.sm)
      }
    }
  }
}
