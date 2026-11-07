// Copyright 2026 Bay. Apache-2.0.
// Chrome owns the desktop process and its message loop. The WebUI window uses
// Chrome's existing tab, permission, extension and sandbox implementations.
#include "bay/core/nn_main_delegate.h"

#include <memory>
#include <utility>

#include "base/base_paths.h"
#include "base/command_line.h"
#include "base/environment.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "bay/core/nn_installed_bubble.h"
#include "bay/core/nn_navigation_hold.h"
#include "bay/core/nn_page_channel.h"
#include "bay/core/nn_request_filter.h"
#include "bay/core/nn_strings.h"
#include "bay/core/renderer/nn_content_renderer_client.h"
#include "build/build_config.h"
#include "chrome/browser/bay/webui/bay_webui.h"
#include "chrome/browser/chrome_browser_main.h"
#include "chrome/browser/chrome_browser_main_extra_parts.h"
#include "chrome/browser/chrome_content_browser_client.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/common/chrome_switches.h"
#include "chrome/common/pref_names.h"
#include "chrome/common/profiler/main_thread_stack_sampling_profiler.h"
#include "components/prefs/pref_service.h"
#include "content/browser/devtools/devtools_instrumentation.h"  // nogncheck
#include "content/public/browser/browser_context.h"
#include "content/public/browser/web_contents.h"
#include "content/public/common/content_switches.h"
#include "net/base/net_errors.h"
#include "net/http/http_request_headers.h"
#include "services/cert_verifier/public/mojom/cert_verifier_service_factory.mojom.h"
#include "services/network/public/mojom/network_context.mojom.h"
#include "services/network/public/mojom/websocket.mojom.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_registry.h"
#include "third_party/blink/public/common/web_preferences/web_preferences.h"
#if BUILDFLAG(IS_LINUX)
#include "chrome/browser/bay/pip/nn_pip_platform.h"
#include "chrome/browser/bay/webui/frame_linux.h"
#include "chrome/browser/ui/webui_browser/webui_browser_window.h"
#endif
#if BUILDFLAG(IS_WIN) || BUILDFLAG(IS_LINUX)
#include "chrome/browser/bay/webui/notifications.h"
#include "chrome/browser/notifications/notification_display_service_factory.h"
#endif
#if BUILDFLAG(IS_WIN)
#include "base/base_paths_win.h"
#include "chrome/browser/bay/webui/frame_win.h"
#include "chrome/browser/ui/webui_browser/webui_browser_window.h"
#endif

namespace nncore {
namespace {

class BayRuntimeMainExtraParts final : public ChromeBrowserMainExtraParts {
 public:
  void PreProfileInit() override {
#if BUILDFLAG(IS_LINUX)
    InitializeBayPictureInPictureBounds();
    WebUIBrowserWindow::SetBayNativeWidgetFactory(
        &bay::FrameLinux::CreateNativeWidget);
#endif
#if BUILDFLAG(IS_WIN)
    WebUIBrowserWindow::SetBayNativeWidgetFactory(
        &bay::FrameWin::CreateNativeWidget);
#endif
#if BUILDFLAG(IS_WIN) || BUILDFLAG(IS_LINUX)
    NotificationDisplayServiceFactory::SetBayHandlerInitializer(
        &bay::Notifications::InstallHandler);
#endif
  }
  void PostMainMessageLoopRun() override { bay::ShutdownAppRuntimeIfStarted(); }
};

// Chrome retains its native UI delegates and process lifetime. NNCore adds the
// same document channel and navigation rules that the macOS host uses.
class NNDesktopContentBrowserClient : public ChromeContentBrowserClient {
 public:
  std::unique_ptr<content::BrowserMainParts> CreateBrowserMainParts(
      bool is_integration_test) override {
    auto parts =
        ChromeContentBrowserClient::CreateBrowserMainParts(is_integration_test);
    static_cast<ChromeBrowserMainParts*>(parts.get())
        ->AddParts(std::make_unique<BayRuntimeMainExtraParts>());
    return parts;
  }

  void RenderProcessWillLaunch(content::RenderProcessHost* host) override {
    ChromeContentBrowserClient::RenderProcessWillLaunch(host);
    SendPageScript(host);
    SendBoosts(host);
  }

  // A Boost's Invert (Arc's): Chrome's forced dark mode on that site's pages, which darkens
  // light pages and keeps photos as they are.
  void OverrideWebPreferences(content::WebContents* web_contents,
                              content::SiteInstance& main_frame_site,
                              blink::web_pref::WebPreferences* prefs) override {
    ChromeContentBrowserClient::OverrideWebPreferences(web_contents,
                                                       main_frame_site, prefs);
    prefs->force_dark_mode_enabled |= BoostInverts(web_contents);
  }
  bool OverrideWebPreferencesAfterNavigation(
      content::WebContents* web_contents,
      content::SiteInstance& main_frame_site,
      blink::web_pref::WebPreferences* prefs) override {
    bool changed =
        ChromeContentBrowserClient::OverrideWebPreferencesAfterNavigation(
            web_contents, main_frame_site, prefs);
    const bool dark = BoostInverts(web_contents);
    if (dark && !prefs->force_dark_mode_enabled) {
      prefs->force_dark_mode_enabled = true;
      changed = true;
    } else if (!dark && prefs->force_dark_mode_enabled &&
               !Profile::FromBrowserContext(web_contents->GetBrowserContext())
                    ->GetPrefs()
                    ->GetBoolean(prefs::kWebKitForceDarkModeEnabled)) {
      // Back to Chrome's own setting once the page leaves the Boost's site.
      prefs->force_dark_mode_enabled = false;
      changed = true;
    }
    return changed;
  }

  void RegisterAssociatedInterfaceBindersForRenderFrameHost(
      content::RenderFrameHost& render_frame_host,
      blink::AssociatedInterfaceRegistry& associated_registry) override {
    ChromeContentBrowserClient::
        RegisterAssociatedInterfaceBindersForRenderFrameHost(
            render_frame_host, associated_registry);
    RegisterPageChannelBinders(render_frame_host, associated_registry);
  }

  void CreateThrottlesForNavigation(
      content::NavigationThrottleRegistry& registry) override {
    ChromeContentBrowserClient::CreateThrottlesForNavigation(registry);
    AddAppSchemeThrottle(registry);
    MaybeAddNavigationHoldThrottle(registry);
    MaybeAddRequestFilterThrottle(registry);
  }

  // The content blocker (nn_request_filter.h) sees a page's requests first, so
  // what it blocks never reaches Chrome's own interceptors (extensions'
  // webRequest).
  void WillCreateURLLoaderFactory(
      content::BrowserContext* browser_context,
      content::RenderFrameHost* frame,
      int render_process_id,
      URLLoaderFactoryType type,
      const url::Origin& request_initiator,
      const net::IsolationInfo& isolation_info,
      std::optional<int64_t> navigation_id,
      ukm::SourceIdObj ukm_source_id,
      network::URLLoaderFactoryBuilder& factory_builder,
      mojo::PendingRemote<network::mojom::TrustedURLLoaderHeaderClient>*
          header_client,
      bool* bypass_redirect_checks,
      bool* disable_secure_dns,
      network::mojom::URLLoaderFactoryOverridePtr* factory_override,
      scoped_refptr<base::SequencedTaskRunner> navigation_response_task_runner,
      bool is_for_network_service) override {
    auto cookie_policy = MaybeFilterURLLoaderFactory(
        type, request_initiator, isolation_info, factory_builder, frame);
    ChromeContentBrowserClient::WillCreateURLLoaderFactory(
        browser_context, frame, render_process_id, type, request_initiator,
        isolation_info, navigation_id, ukm_source_id, factory_builder,
        header_client, bypass_redirect_checks, disable_secure_dns,
        factory_override, std::move(navigation_response_task_runner),
        is_for_network_service);
    if (cookie_policy)
      std::move(cookie_policy).Run(header_client);
  }

  void ExposeInterfacesToRenderer(
      service_manager::BinderRegistry* registry,
      blink::AssociatedInterfaceRegistry* associated_registry,
      content::RenderProcessHost* render_process_host) override {
    ChromeContentBrowserClient::ExposeInterfacesToRenderer(
        registry, associated_registry, render_process_host);
    // The content blocker's scriptlets, which each document asks for as it
    // starts.
    ExposeScriptlets(registry);
  }

  bool WillInterceptWebSocket(content::RenderFrameHost* frame) override {
    return HasRequestFilter() ||
           ChromeContentBrowserClient::WillInterceptWebSocket(frame);
  }

  void CreateWebSocket(
      content::RenderFrameHost* frame,
      WebSocketFactory factory,
      const GURL& url,
      const net::SiteForCookies& site_for_cookies,
      const std::optional<std::string>& user_agent,
      mojo::PendingRemote<network::mojom::WebSocketHandshakeClient> client,
      WebSocketOptions options) override {
    if (ShouldBlockWebSocket(frame, url, site_for_cookies)) {
      mojo::Remote<network::mojom::WebSocketHandshakeClient>(std::move(client))
          ->OnFailure("Blocked by Bay's content blocker",
                      net::ERR_BLOCKED_BY_CLIENT, 0);
      return;
    }
    if (ChromeContentBrowserClient::WillInterceptWebSocket(frame)) {
      ChromeContentBrowserClient::CreateWebSocket(
          frame, std::move(factory), url, site_for_cookies, user_agent,
          std::move(client), std::move(options));
      return;
    }
    // Chrome only proxies frames with extension webRequest listeners. Workers
    // and other sockets still need the ordinary network factory when allowed.
    // DevTools' Network.setExtraHTTPHeaders reaches a socket over this path
    // only if applied here: it bypasses the URLLoader override.
    net::HttpRequestHeaders extra;
    if (user_agent)
      extra.SetHeader(net::HttpRequestHeaders::kUserAgent, *user_agent);
    if (frame) {
      content::devtools_instrumentation::ApplyExtraHeadersForWebSocket(
          frame->GetGlobalId(), std::nullopt, &extra);
    }
    std::vector<network::mojom::HttpHeaderPtr> headers;
    for (net::HttpRequestHeaders::Iterator it(extra); it.GetNext();)
      headers.push_back(network::mojom::HttpHeader::New(it.name(), it.value()));
    std::move(factory).Run(url, std::move(headers), std::move(client),
                           mojo::NullRemote(), std::move(options.header_client));
  }

  bool ConfigureNetworkContextParams(
      content::BrowserContext* context,
      bool in_memory,
      const base::FilePath& relative_partition_path,
      network::mojom::NetworkContextParams* network_context_params,
      cert_verifier::mojom::CertVerifierCreationParams*
          cert_verifier_creation_params) override {
    const bool result =
        ChromeContentBrowserClient::ConfigureNetworkContextParams(
            context, in_memory, relative_partition_path, network_context_params,
            cert_verifier_creation_params);
    // Bay restores its workspace itself. Chrome must still preserve session
    // cookies for regular profiles between launches, as on macOS.
    if (!in_memory && relative_partition_path.empty() &&
        !context->IsOffTheRecord()) {
      network_context_params->restore_old_session_cookies = true;
      network_context_params->persist_session_cookies = true;
    }
    return result;
  }
};

}  // namespace

NNMainDelegate::NNMainDelegate(const StartupTimestamps& timestamps)
    : ChromeMainDelegate(timestamps) {}
NNMainDelegate::~NNMainDelegate() = default;

std::optional<int> NNMainDelegate::BasicStartupComplete() {
  auto* command = base::CommandLine::ForCurrentProcess();
  if (!command->HasSwitch(switches::kProcessType)) {
    std::string enabled = command->GetSwitchValueASCII("enable-features");
    if (!enabled.empty())
      enabled += ",";
    enabled += "Webium,SurfaceEmbed,WebContentsDiscard";
    command->AppendSwitchASCII("enable-features", enabled);
    command->AppendSwitch("no-first-run");
    command->AppendSwitch("no-default-browser-check");
    // Bay opens its own windows, each in its space's profile, from Default's
    // coordinator: Chrome starts there, and never shows its profile picker
    // (spaces' profiles are Chrome profiles too).
    if (!command->HasSwitch(switches::kProfileDirectory))
      command->AppendSwitchASCII(switches::kProfileDirectory, "Default");
    if (!command->HasSwitch(switches::kUserDataDir)) {
      auto environment = base::Environment::Create();
      auto custom = environment->GetVar("BAY_DATA_DIR");
      base::FilePath directory;
      if (custom && !custom->empty()) {
        directory = base::FilePath::FromUTF8Unsafe(*custom);
        if (!directory.IsAbsolute()) {
          base::FilePath current;
          CHECK(base::GetCurrentDirectory(&current));
          directory = current.Append(directory);
        }
      }
      if (directory.empty()) {
#if BUILDFLAG(IS_WIN)
        CHECK(base::PathService::Get(base::DIR_LOCAL_APP_DATA, &directory));
        directory = directory.AppendASCII("Bay");
#else
        auto xdg = environment->GetVar("XDG_CONFIG_HOME");
        if (xdg)
          directory = base::FilePath::FromUTF8Unsafe(*xdg);
        if (!directory.IsAbsolute()) {
          CHECK(base::PathService::Get(base::DIR_HOME, &directory));
          directory = directory.AppendASCII(".config");
        }
        directory = directory.AppendASCII("Bay");
#endif
      }
      command->AppendSwitchPath(switches::kUserDataDir, directory);
    }
#if BUILDFLAG(IS_WIN)
    // Every launch writes Bay.log in the data folder and keeps the launch
    // before it as Bay.previous.log, so a start-up failure or a crash can be
    // read afterwards. Warnings and errors only: chrome://bay's console errors
    // are among them, and websites' console messages (always INFO) stay out.
    // An --enable-logging on the command line replaces all of this.
    if (!command->HasSwitch(switches::kEnableLogging)) {
      const auto directory =
          command->GetSwitchValuePath(switches::kUserDataDir);
      const auto log = directory.AppendASCII("Bay.log");
      // A running Bay holds its log open, so this fails for a launch that only
      // hands its arguments to it, and that launch appends instead.
      base::Move(log, directory.AppendASCII("Bay.previous.log"));
      command->AppendSwitch(switches::kEnableLogging);
      command->AppendSwitchPath(switches::kLogFile, log);
      if (!command->HasSwitch(switches::kLoggingLevel))
        command->AppendSwitchASCII(switches::kLoggingLevel, "1");
    }
#endif
  }
  return ChromeMainDelegate::BasicStartupComplete();
}
void NNMainDelegate::PreSandboxStartup() {
  if (!base::CommandLine::ForCurrentProcess()->HasSwitch(
          switches::kProcessType)) {
    InstallExtensionInstalledHook();
  }
  ChromeMainDelegate::PreSandboxStartup();
}
void NNMainDelegate::CreateThreadPool(std::string_view name) {
  ChromeMainDelegate::CreateThreadPool(name);
}
content::ContentBrowserClient* NNMainDelegate::CreateContentBrowserClient() {
  chrome_content_browser_client_ =
      std::make_unique<NNDesktopContentBrowserClient>();
  if (sampling_profiler_) {
    chrome_content_browser_client_->SetSamplingProfiler(
        std::move(sampling_profiler_));
  }
  return chrome_content_browser_client_.get();
}
content::ContentRendererClient* NNMainDelegate::CreateContentRendererClient() {
  static base::NoDestructor<NNContentRendererClient> client;
  return client.get();
}
ui::ResourceBundle::Delegate* NNMainDelegate::GetResourceBundleDelegate() {
  return ProductStrings();
}
}  // namespace nncore
