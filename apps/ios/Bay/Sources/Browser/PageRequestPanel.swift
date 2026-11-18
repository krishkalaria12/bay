import BayCore
import BayDesign
import BayEngine
import SwiftUI

/// A page's `alert`/`confirm`/`prompt`, the server's HTTP sign-in, a link to another app or a device permission, as one
/// sheet instead of WebKit's own dialogs. The page waits until this answers, so dismissing the sheet cancels the
/// dialog, as a dismissed browser dialog would.
struct PageRequestPanel: View {
  @EnvironmentObject private var strings: Strings
  @ObservedObject var browser: BrowserModel
  let request: PageRequest
  @State private var value = ""
  @State private var username = ""
  @State private var password = ""

  var body: some View {
    let host = hostOf(url: request.url)
    let title = host.isEmpty ? strings.t("pageRequest.thisPage") : host
    PanelSheet(title: title, testID: "page-request", words: strings.sheetWords(title), onClose: { browser.answerPageRequest(accepted: false) }) {
      VStack(alignment: .leading, spacing: Space.sm) {
        message
        if request.kind == .prompt {
          field(strings.t("pageRequest.answer"), text: $value, id: "page-request-input")
        }
        if request.kind == .auth {
          field(strings.t("pageRequest.username"), text: $username, id: "page-request-username").textContentType(.username)
          SecureField(strings.t("pageRequest.password"), text: $password)
            .textContentType(.password)
            .submitLabel(.go)
            .onSubmit(submit)
            .padding(.horizontal, Space.lg)
            .frame(minHeight: 44)
            .background(BayColor.fill, in: Capsule())
            .accessibilityIdentifier("page-request-password")
        }
        HStack(spacing: Space.sm) {
          Spacer(minLength: 0)
          if request.kind != .alert {
            let cancel = request.kind == .permission ? strings.t("pageRequest.dontAllow") : strings.t("pageRequest.cancel")
            PillButton(cancel) { browser.answerPageRequest(accepted: false) }
              .accessibilityIdentifier("page-request-cancel")
          }
          PillButton(okLabel, action: submit)
            .accessibilityLabel(Text(verbatim: request.kind == .external ? strings.t("pageRequest.openElsewhere") : okLabel))
            .accessibilityIdentifier("page-request-ok")
        }
        .padding(.top, Space.sm)
        if !request.url.isEmpty {
          BayText(request.url, variant: .subhead, tone: .muted).lineLimit(1).padding(.top, Space.xs)
            .accessibilityIdentifier("page-request-url")
        }
      }
    }
    .onAppear { value = request.defaultValue ?? "" }
  }

  @ViewBuilder private var message: some View {
    switch request.kind {
    case .auth:
      BayText(
        request.realm.map { strings.t("pageRequest.auth.realm", ["realm": $0]) } ?? strings.t("pageRequest.auth.site"), variant: .subhead,
        tone: .muted
      )
      .accessibilityIdentifier("page-request-realm")
    case .permission:
      BayText(strings.t(Self.permissionMessage(request.permission))).accessibilityIdentifier("page-request-permission-message")
    case .external:
      BayText(strings.t("pageRequest.external")).accessibilityIdentifier("page-request-external-message")
      BayText(request.externalUrl ?? "", variant: .subhead, tone: .muted).lineLimit(2).accessibilityIdentifier("page-request-external")
    default:
      if !request.message.isEmpty { BayText(request.message).accessibilityIdentifier("page-request-message") }
    }
  }

  private var okLabel: String {
    switch request.kind {
    case .auth: return strings.t("pageRequest.signIn")
    case .external: return strings.t("pageRequest.open")
    case .permission: return strings.t("pageRequest.allow")
    default: return strings.t("pageRequest.ok")
    }
  }

  /// What a page asking for a device says, in Bay's own words.
  private static func permissionMessage(_ permission: String?) -> String {
    switch permission {
    case "microphone": return "pageRequest.permission.microphone"
    case "location": return "pageRequest.permission.location"
    case "camera-microphone": return "pageRequest.permission.cameraMicrophone"
    default: return "pageRequest.permission.camera"
    }
  }

  private func field(_ label: String, text: Binding<String>, id: String) -> some View {
    TextField(label, text: text)
      .textInputAutocapitalization(.never)
      .disableAutocorrection(true)
      .submitLabel(.done)
      .onSubmit(submit)
      .padding(.horizontal, Space.lg)
      .frame(minHeight: 44)
      .background(BayColor.fill, in: Capsule())
      .accessibilityIdentifier(id)
  }

  private func submit() {
    browser.answerPageRequest(
      accepted: true, value: request.kind == .prompt ? value : nil, username: request.kind == .auth ? username : nil,
      password: request.kind == .auth ? password : nil)
  }
}
