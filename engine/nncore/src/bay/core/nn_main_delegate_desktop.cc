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
#include "bay/core/nn_strings.h"
#include "bay/core/renderer/nn_content_renderer_client.h"
#include "build/build_config.h"
#include "chrome/browser/bay/webui/bay_webui.h"
#include "chrome/browser/chrome_browser_main.h"
#include "chrome/browser/chrome_browser_main_extra_parts.h"
#include "chrome/browser/chrome_content_browser_client.h"
#include "chrome/common/chrome_switches.h"
#include "chrome/common/profiler/main_thread_stack_sampling_profiler.h"
#include "content/public/browser/browser_context.h"
#include "content/public/common/content_switches.h"
#include "services/cert_verifier/public/mojom/cert_verifier_service_factory.mojom.h"
#include "services/network/public/mojom/network_context.mojom.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_registry.h"
#if BUILDFLAG(IS_WIN)
#include "base/base_paths_win.h"
#include "chrome/browser/bay/webui/frame_win.h"
#include "chrome/browser/bay/webui/notifications_win.h"
#include "chrome/browser/notifications/notification_display_service_factory.h"
#include "chrome/browser/ui/webui_browser/webui_browser_window.h"
#endif

namespace nncore {
namespace {

class BayRuntimeMainExtraParts final : public ChromeBrowserMainExtraParts {
 public:
#if BUILDFLAG(IS_WIN)
  void PreProfileInit() override {
    NotificationDisplayServiceFactory::SetBayHandlerInitializer(
        &bay::NotificationsWin::InstallHandler);
    WebUIBrowserWindow::SetBayNativeWidgetFactory(
        &bay::FrameWin::CreateNativeWidget);
  }
#endif
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
