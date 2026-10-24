#include "bay/core/nn_main_delegate.h"

#include <algorithm>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

#include "base/base_switches.h"
#include "base/command_line.h"
#include "base/environment.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/run_loop.h"
#include "base/strings/cstring_view.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/task/single_thread_task_runner.h"
#include "base/time/time.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/browser_process_impl.h"
#include "chrome/browser/chrome_browser_main.h"
#include "chrome/browser/chrome_browser_main_extra_parts.h"
#include "chrome/browser/chrome_content_browser_client.h"
#include "chrome/common/chrome_paths.h"
#include "chrome/common/chrome_paths_internal.h"
#include "chrome/common/chrome_switches.h"
#include "chrome/common/profiler/main_thread_stack_sampling_profiler.h"
#include "components/component_updater/component_updater_paths.h"
#include "components/keep_alive_registry/keep_alive_types.h"
#include "components/keep_alive_registry/scoped_keep_alive.h"
#include "components/os_crypt/common/os_crypt_switches.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/browser_main_parts.h"
#include "content/public/common/content_switches.h"
#include "content/public/common/result_codes.h"
#include "extensions/common/switches.h"
#include "services/cert_verifier/public/mojom/cert_verifier_service_factory.mojom.h"
#include "services/network/public/mojom/network_context.mojom.h"
#include "bay/core/nn_lifetime.h"
#include "bay/core/nn_context_menu.h"
#include "bay/core/nn_navigation_hold.h"
#include "bay/core/nn_page_channel.h"
#include "bay/core/nn_peek_links.h"
#include "bay/core/nn_strings.h"
#include "content/public/browser/web_contents_view_delegate.h"
#include "bay/core/renderer/nn_content_renderer_client.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_registry.h"
#include "third_party/blink/public/common/switches.h"

// The user agent brand hook (engine/nncore/apply.sh).
extern const char* g_bay_user_agent_brand;
// The idle wakeup hooks (engine/nncore/apply.sh).
extern bool g_bay_skip_cpu_health_sampling;
extern int g_bay_disk_space_check_seconds;
extern bool g_bay_bluetooth_poll_on_demand;
extern bool g_bay_hybrid_scan_on_demand;

namespace nncore {

namespace {

EngineCallbacks& Callbacks() {
  static base::NoDestructor<EngineCallbacks> callbacks;
  return *callbacks;
}

// What AppController does for Chrome on the Mac: the app outlives its last window.
// Chrome finished starting the browser (profiles loaded, PostBrowserStart ran). Chrome
// can also return 0 from PreMainMessageLoopRun when the initial profile fails.
bool g_browser_started = false;

// Switches that open the profile to outside control (DevTools, automation, unpacked extensions) or leak or redirect a
// session's traffic. On the real keychain they would hand whoever started the app the owner's cookies and saved
// passwords without Touch ID.
constexpr const char* kSwitchesThatOpenTheProfile[] = {
    "allow-insecure-localhost",
    "auto-open-devtools-for-tabs",
    "custom-devtools-frontend",
    "devtools-flags",
    "disable-extensions-except",
    "disable-web-security",
    "enable-automation",
    "enable-ui-devtools",
    "extensions-on-chrome-urls",
    "extensions-on-extension-urls",
    "host-resolver-rules",
    "host-rules",
    "ignore-certificate-errors",
    "ignore-certificate-errors-spki-list",
    "load-apps",
    "load-extension",
    "log-net-log",
    "net-log-capture-mode",
    "proxy-pac-url",
    "proxy-server",
    "remote-allow-origins",
    "remote-debugging-address",
    "remote-debugging-io-pipes",
    "remote-debugging-pipe",
    "remote-debugging-port",
    "remote-debugging-socket-name",
    "remote-debugging-targets",
    "silent-debugger-extension-api",
    "ssl-key-log-file",
    "unsafely-treat-insecure-origin-as-secure",
    "webtransport-developer-mode",
};

constexpr base::cstring_view kEnvironmentThatOpensTheProfile[] = {
    "SSLKEYLOGFILE",
};

void RemoveSwitchesThatOpenTheProfile(base::CommandLine* command_line) {
  for (const char* name : kSwitchesThatOpenTheProfile) {
    command_line->RemoveSwitch(name);
  }
}

// The browser process on the real keychain drops every switch above, from wherever it came (the host forwards no argv
// or BAY_CHROMIUM_SWITCHES there, but Chromium also reads single-dash and padded spellings, and chrome://flags adds
// switches later). RemoveSwitch works on the parsed key, so every spelling and value form goes. The test is the same
// switch Chrome's KeychainKeyProvider reads to pick its fake key, so the gate can't stand down without the process
// also losing the real Safe Storage key. --bay-show-profile-gate logs what it would leave.
void KeepRealProfileClosed(base::CommandLine* command_line,
                           std::string_view stage) {
  const bool mock_keychain =
      command_line->HasSwitch(os_crypt::switches::kUseMockKeychain);
  if (command_line->HasSwitch("bay-show-profile-gate")) {
    base::CommandLine closed(*command_line);
    RemoveSwitchesThatOpenTheProfile(&closed);
    LOG(ERROR) << "[nncore] profile gate " << stage << " (applies here: "
               << (mock_keychain ? "no" : "yes") << ")\n  parsed: "
               << command_line->GetCommandLineString()
               << "\n  closed: " << closed.GetCommandLineString();
  }
  if (!mock_keychain) {
    RemoveSwitchesThatOpenTheProfile(command_line);
    std::unique_ptr<base::Environment> env = base::Environment::Create();
    for (base::cstring_view name : kEnvironmentThatOpensTheProfile) {
      env->UnSetVar(name);
    }
  }
}

bool EnvIs(const char* name, std::string_view value) {
  const char* set = getenv(name);
  return set && value == set;
}

void MergeFeatures(base::CommandLine* command_line,
                   const char* list,
                   std::string_view features) {
  const std::string current = command_line->GetSwitchValueASCII(list);
  command_line->RemoveSwitch(list);
  command_line->AppendSwitchASCII(
      list, current.empty() ? std::string(features)
                            : current + "," + std::string(features));
}

// Chrome's own periodic work in an idle browser, made rarer (the browser process's wakeups at one idle tab: 3.4 a
// second before). Each has a kill switch in the environment:
// - PartitionAlloc's memory reclaimer runs every 4 s on the main thread of every process. Chromium's adaptive interval
//   backs off towards a minute while there's under 100 KiB to decommit (BAY_PA_RECLAIM=fixed);
// - CpuHealthTracker samples CPU every 15 s for a toolbar button Bay doesn't show (BAY_CPU_HEALTH_SAMPLING=on);
// - free disk is checked every 60 s instead of 5 while more than 20 GiB are free (BAY_DISK_CHECK_SECONDS, 0-3600;
//   0 or 5 is Chrome's);
// - Bluetooth polls bluetoothd only while discovering, and the phone scan for passkeys runs only while its sheet
//   shows, instead of every 500 ms for as long as a sign-in page offering passkeys is open
//   (BAY_BLUETOOTH_POLL_ON_DEMAND=off, BAY_HYBRID_SCAN_ON_DEMAND=off).
void QuietIdleTimers(base::CommandLine* command_line) {
  if (!EnvIs("BAY_PA_RECLAIM", "fixed")) {
    MergeFeatures(command_line, switches::kEnableFeatures,
                  "PartitionAllocAdaptiveMemoryReclaimInterval");
  }
  g_bay_skip_cpu_health_sampling = !EnvIs("BAY_CPU_HEALTH_SAMPLING", "on");
  int disk_check_seconds = 60;
  if (const char* set = getenv("BAY_DISK_CHECK_SECONDS");
      set && !base::StringToInt(set, &disk_check_seconds)) {
    disk_check_seconds = 0;
  }
  g_bay_disk_space_check_seconds = std::clamp(disk_check_seconds, 0, 3600);
  g_bay_bluetooth_poll_on_demand =
      !EnvIs("BAY_BLUETOOTH_POLL_ON_DEMAND", "off");
  g_bay_hybrid_scan_on_demand = !EnvIs("BAY_HYBRID_SCAN_ON_DEMAND", "off");
}

// The host turns V8's memory reducer off (its mark-compacts after each page load kept every renderer busy). An
// extension's background process keeps it, so its heap still shrinks when idle.
void KeepMemoryReducer(base::CommandLine* command_line) {
  const std::string flags =
      command_line->GetSwitchValueASCII(blink::switches::kJavaScriptFlags);
  std::vector<std::string> kept;
  bool dropped = false;
  for (const std::string& flag :
       base::SplitString(flags, " ,", base::TRIM_WHITESPACE,
                         base::SPLIT_WANT_NONEMPTY)) {
    if (flag == "--no-memory-reducer" || flag == "--no_memory_reducer") {
      dropped = true;
    } else {
      kept.push_back(flag);
    }
  }
  if (!dropped) {
    return;
  }
  command_line->RemoveSwitch(blink::switches::kJavaScriptFlags);
  if (!kept.empty()) {
    command_line->AppendSwitchASCII(blink::switches::kJavaScriptFlags,
                                    base::JoinString(kept, " "));
  }
}

std::unique_ptr<ScopedKeepAlive>& AppKeepAlive() {
  static base::NoDestructor<std::unique_ptr<ScopedKeepAlive>> keep_alive;
  return *keep_alive;
}

class NNBrowserMainExtraParts : public ChromeBrowserMainExtraParts {
 public:
  void PreBrowserStart() override {
    AppKeepAlive() = std::make_unique<ScopedKeepAlive>(
        KeepAliveOrigin::APP_CONTROLLER, KeepAliveRestartOption::DISABLED);
    StartLifetimeObservers();
  }
  void PostBrowserStart() override {
    g_browser_started = true;
    // The host starts once the loop runs, so it can nest run loops and post tasks.
    if (Callbacks().started) {
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE, std::move(Callbacks().started));
    }
  }
  void PostMainMessageLoopRun() override {
    if (Callbacks().shutting_down) {
      std::move(Callbacks().shutting_down).Run();
    }
  }
};

// Chrome's main parts, plus the one thing CEF took out: Chrome running its main loop.
// (CEF bypasses StartupBrowserCreator and runs a loop of its own.)
class NNBrowserMainParts : public content::BrowserMainParts {
 public:
  explicit NNBrowserMainParts(std::unique_ptr<content::BrowserMainParts> chrome)
      : chrome_(std::move(chrome)) {}

  int PreEarlyInitialization() override {
    return chrome_->PreEarlyInitialization();
  }
  void PostEarlyInitialization() override {
    chrome_->PostEarlyInitialization();
  }
  void ToolkitInitialized() override { chrome_->ToolkitInitialized(); }
  void PreCreateMainMessageLoop() override {
    chrome_->PreCreateMainMessageLoop();
  }
  void PostCreateMainMessageLoop() override {
    chrome_->PostCreateMainMessageLoop();
  }
  int PreCreateThreads() override { return chrome_->PreCreateThreads(); }
  void PostCreateThreads() override { chrome_->PostCreateThreads(); }
  int PreMainMessageLoopRun() override {
    result_ = chrome_->PreMainMessageLoopRun();
    return result_;
  }
  bool ShouldInterceptMainMessageLoopRun() override {
    return result_ == content::RESULT_CODE_NORMAL_EXIT && g_browser_started;
  }
  void WillRunMainMessageLoop(std::unique_ptr<base::RunLoop>& run_loop) override {
    chrome_->WillRunMainMessageLoop(run_loop);
    if (!run_loop) {
      // As ChromeBrowserMainParts does after StartupBrowserCreator: the loop ends
      // when the last keep-alive goes (BrowserProcessImpl::Unpin).
      run_loop = std::make_unique<base::RunLoop>();
      static_cast<BrowserProcessImpl*>(g_browser_process)
          ->SetQuitClosure(run_loop->QuitWhenIdleClosure());
    }
  }
  void OnFirstIdle() override { chrome_->OnFirstIdle(); }
  void PostMainMessageLoopRun() override { chrome_->PostMainMessageLoopRun(); }
  void PostDestroyThreads() override { chrome_->PostDestroyThreads(); }

 private:
  std::unique_ptr<content::BrowserMainParts> chrome_;
  int result_ = content::RESULT_CODE_NORMAL_EXIT;
};

class NNContentBrowserClient : public ChromeContentBrowserClient {
 public:
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
  std::unique_ptr<content::WebContentsViewDelegate> GetWebContentsViewDelegate(
      content::WebContents* web_contents) override {
    return CreateViewDelegate(web_contents);
  }
  void CreateThrottlesForNavigation(
      content::NavigationThrottleRegistry& registry) override {
    ChromeContentBrowserClient::CreateThrottlesForNavigation(registry);
    AddAppSchemeThrottle(registry);
    MaybeAddNavigationHoldThrottle(registry);
    MaybeAddPeekLinksThrottle(registry);
  }
  // The spare renderer that replaces one a navigation took starts a moment later, not
  // within that navigation's own start: its RenderProcessHostImpl::Init held the UI
  // thread ~7 ms inside a new tab's creation, which in a new window is the middle of
  // the window's first layout, delaying the page's request and first paint.
  std::optional<base::TimeDelta> GetSpareRendererDelayForSiteURL(
      const GURL& site_url) override {
    std::optional<base::TimeDelta> delay =
        ChromeContentBrowserClient::GetSpareRendererDelayForSiteURL(site_url);
    return delay ? delay : std::optional<base::TimeDelta>(base::Milliseconds(500));
  }

  bool ConfigureNetworkContextParams(
      content::BrowserContext* context,
      bool in_memory,
      const base::FilePath& relative_partition_path,
      network::mojom::NetworkContextParams* network_context_params,
      cert_verifier::mojom::CertVerifierCreationParams*
          cert_verifier_creation_params) override {
    const bool result = ChromeContentBrowserClient::ConfigureNetworkContextParams(
        context, in_memory, relative_partition_path, network_context_params,
        cert_verifier_creation_params);
    // Session cookies outlive a restart, as they did on CEF (which set
    // session.restore_on_startup to "last session"): a profile's main on-disk partition
    // keeps and restores them. Chrome would drop them unless it restores its own last
    // session, which the app does itself. Private profiles stay in memory.
    if (!in_memory && relative_partition_path.empty() &&
        !context->IsOffTheRecord()) {
      network_context_params->restore_old_session_cookies = true;
      network_context_params->persist_session_cookies = true;
    }
    return result;
  }

  std::unique_ptr<content::BrowserMainParts> CreateBrowserMainParts(
      bool is_integration_test) override {
    std::unique_ptr<content::BrowserMainParts> chrome =
        ChromeContentBrowserClient::CreateBrowserMainParts(is_integration_test);
    static_cast<ChromeBrowserMainParts*>(chrome.get())
        ->AddParts(std::make_unique<NNBrowserMainExtraParts>());
    return std::make_unique<NNBrowserMainParts>(std::move(chrome));
  }
};

}  // namespace

void SetEngineCallbacks(EngineCallbacks callbacks) {
  Callbacks() = std::move(callbacks);
}

void ReleaseAppKeepAlive() {
  AppKeepAlive().reset();
}

NNMainDelegate::NNMainDelegate(const StartupTimestamps& timestamps)
    : ChromeMainDelegate(timestamps) {}

NNMainDelegate::~NNMainDelegate() = default;

std::optional<int> NNMainDelegate::BasicStartupComplete() {
  base::CommandLine* command_line = base::CommandLine::ForCurrentProcess();
  if (!command_line->HasSwitch(switches::kProcessType)) {
    KeepRealProfileClosed(command_line, "at startup");
    QuietIdleTimers(command_line);
  }
  if (command_line->HasSwitch(extensions::switches::kExtensionProcess)) {
    KeepMemoryReducer(command_line);
  }
  return ChromeMainDelegate::BasicStartupComplete();
}

std::optional<int> NNMainDelegate::PostEarlyInitialization(
    InvokedIn invoked_in) {
  std::optional<int> exit_code =
      ChromeMainDelegate::PostEarlyInitialization(invoked_in);
  if (std::holds_alternative<InvokedInBrowserProcess>(invoked_in)) {
    KeepRealProfileClosed(base::CommandLine::ForCurrentProcess(),
                          "after chrome://flags");
  }
  return exit_code;
}

void NNMainDelegate::PreSandboxStartup() {
  const base::CommandLine& command_line =
      *base::CommandLine::ForCurrentProcess();
  const std::string process_type =
      command_line.GetSwitchValueASCII(switches::kProcessType);
  if (chrome::ProcessNeedsProfileDir(process_type)) {
    // The host always names the data dir. Never fall back to Chromium's default
    // (~/Library/Application Support/Chromium): that is someone else's profile.
    base::FilePath dir = command_line.GetSwitchValuePath(switches::kUserDataDir);
    if (dir.empty() && !process_type.empty()) {
      // A helper Chrome launched without it (the browser always has one). It never opens a
      // profile; it gets a scratch path rather than Chromium's default.
      base::FilePath scratch;
      if (base::GetTempDir(&scratch)) {
        base::PathService::OverrideAndCreateIfNeeded(
            chrome::DIR_USER_DATA, scratch.Append("nncore-helper"),
            /*is_absolute=*/true, /*create=*/false);
      }
      ChromeMainDelegate::PreSandboxStartup();
      return;
    }
    CHECK(!dir.empty()) << "NNCore needs --user-data-dir";
    CHECK(base::CreateDirectory(dir));
    dir = base::MakeAbsoluteFilePath(dir);
    CHECK(base::PathService::OverrideAndCreateIfNeeded(
        chrome::DIR_USER_DATA, dir, /*is_absolute=*/true, /*create=*/false));
    base::PathService::Override(chrome::DIR_CRASH_DUMPS,
                                dir.Append(FILE_PATH_LITERAL("Crashpad")));
    component_updater::RegisterPathProvider(chrome::DIR_COMPONENTS,
                                            chrome::DIR_USER_DATA);
  }
  if (process_type.empty()) {
    InstallAppOverrides();
    // Client hints and navigator.userAgentData say "Google Chrome", as Chrome's and Arc's and
    // Dia's do (the user agent string already does): Meet's automatic Picture in Picture, among
    // others, is offered only there (engine/nncore/apply.sh's hook).
    g_bay_user_agent_brand = "Google Chrome";
  }
  ChromeMainDelegate::PreSandboxStartup();
}

void NNMainDelegate::CreateThreadPool(std::string_view name) {
  ChromeMainDelegate::CreateThreadPool(name);
  // Started as early as Chrome starts it: once the thread pool exists.
  sampling_profiler_ = std::make_unique<MainThreadStackSamplingProfiler>();
}

ui::ResourceBundle::Delegate* NNMainDelegate::GetResourceBundleDelegate() {
  return ProductStrings();
}

content::ContentRendererClient* NNMainDelegate::CreateContentRendererClient() {
  static base::NoDestructor<NNContentRendererClient> client;
  return client.get();
}

content::ContentBrowserClient* NNMainDelegate::CreateContentBrowserClient() {
  chrome_content_browser_client_ = std::make_unique<NNContentBrowserClient>();
  if (sampling_profiler_) {
    chrome_content_browser_client_->SetSamplingProfiler(
        std::move(sampling_profiler_));
  }
  return chrome_content_browser_client_.get();
}

}  // namespace nncore
