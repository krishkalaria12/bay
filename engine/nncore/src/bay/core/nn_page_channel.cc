#include "bay/core/nn_page_channel.h"

#include <algorithm>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/task/bind_post_task.h"
#include "base/task/single_thread_task_runner.h"
#include "bay/core/nn_tab_events.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/render_process_host.h"
#include "content/public/browser/render_view_host.h"
#include "content/public/browser/render_widget_host.h"
#include "content/public/browser/render_widget_host_iterator.h"
#include "content/public/browser/web_contents.h"
#include "ipc/ipc_channel_proxy.h"
#include "mojo/public/cpp/bindings/associated_remote.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_provider.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_registry.h"
#include "third_party/blink/public/common/web_preferences/web_preferences.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace nncore {

namespace {

std::string& Script() {
  static base::NoDestructor<std::string> script;
  return *script;
}

std::vector<Boost>& BoostList() {
  static base::NoDestructor<std::vector<Boost>> boosts;
  return *boosts;
}

// As the renderer names a document's site (nn_content_renderer_client.cc › BoostHost).
std::string BoostHost(const GURL& url) {
  if (!url.SchemeIsHTTPOrHTTPS()) {
    return std::string();
  }
  std::string host = base::ToLowerASCII(url.host());
  if (base::EndsWith(host, ".")) {
    host.pop_back();
  }
  if (base::StartsWith(host, "www.")) {
    host = host.substr(4);
  }
  return host;
}

// Every tab's WebContents (and any other with a renderer view).
std::vector<content::WebContents*> AllContents() {
  std::vector<content::WebContents*> all;
  std::unique_ptr<content::RenderWidgetHostIterator> widgets(
      content::RenderWidgetHost::GetRenderWidgetHosts());
  while (content::RenderWidgetHost* widget = widgets->GetNextHost()) {
    content::RenderViewHost* view = content::RenderViewHost::From(widget);
    content::WebContents* contents =
        view ? content::WebContents::FromRenderViewHost(view) : nullptr;
    if (contents && std::find(all.begin(), all.end(), contents) == all.end()) {
      all.push_back(contents);
    }
  }
  return all;
}

mojo::AssociatedRemote<mojom::NNPage> PageOf(content::RenderFrameHost* frame) {
  mojo::AssociatedRemote<mojom::NNPage> page;
  if (frame && frame->IsRenderFrameLive()) {
    frame->GetRemoteAssociatedInterfaces()->GetInterface(&page);
  }
  return page;
}

// Web pages may not navigate to or open bay: URLs (the app's own pages, which
// only the app maps): cancelled silently. Chrome's pages (chrome:, devtools:)
// may ask for one in their main frame: cancelled too, and the host is told
// (tab:didRequestAppURL:userGesture:), as CEF's NNClient told the app.
class AppSchemeThrottle : public content::NavigationThrottle {
 public:
  explicit AppSchemeThrottle(content::NavigationThrottleRegistry& registry)
      : content::NavigationThrottle(registry) {}

  ThrottleCheckResult WillStartRequest() override { return Check(); }
  ThrottleCheckResult WillRedirectRequest() override { return Check(); }
  const char* GetNameForLogging() override { return "NNAppSchemeThrottle"; }

 private:
  ThrottleCheckResult Check() {
    content::NavigationHandle* navigation = navigation_handle();
    if (!IsAppURL(navigation->GetURL())) {
      return PROCEED;
    }
    content::WebContents* contents = navigation->GetWebContents();
    const std::optional<url::Origin>& initiator =
        navigation->GetInitiatorOrigin();
    content::NavigationEntry* committed =
        contents->GetController().GetLastCommittedEntry();
    // A new popup's first navigation is reported by the opener's delegate
    // instead (NNWebContentsDelegate), which drops the popup.
    const bool popup_start = !committed || committed->IsInitialEntry();
    if (navigation->IsInPrimaryMainFrame() && !popup_start &&
        !navigation->WasServerRedirect() && initiator &&
        IsWebUIURL(initiator->GetURL()) &&
        IsWebUIURL(contents->GetPrimaryMainFrame()->GetLastCommittedURL())) {
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE, base::BindOnce(
                         [](base::WeakPtr<content::WebContents> contents,
                            GURL url, bool user_gesture) {
                           if (contents) {
                             ReportAppURLRequest(contents.get(), url,
                                                 user_gesture);
                           }
                         },
                         contents->GetWeakPtr(), navigation->GetURL(),
                         navigation->HasUserGesture()));
    }
    return CANCEL_AND_IGNORE;
  }
};

}  // namespace

bool IsAppURL(const GURL& url) {
  return url.SchemeIs("bay");
}

bool IsWebUIURL(const GURL& url) {
  return url.SchemeIs("chrome") || url.SchemeIs("devtools");
}

void SetPageScript(const std::string& script) {
  Script() = script;
  for (auto it = content::RenderProcessHost::AllHostsIterator(); !it.IsAtEnd();
       it.Advance()) {
    content::RenderProcessHost* host = it.GetCurrentValue();
    if (host->IsInitializedAndNotDead()) {
      SendPageScript(host);
    }
  }
}

const std::string& GetPageScript() {
  return Script();
}

void SendPageScript(content::RenderProcessHost* host) {
  // On the process's IPC channel, so it arrives before the messages that create
  // frames (RenderProcessWillLaunch runs just after the channel is unpaused).
  IPC::ChannelProxy* channel = host->GetChannel();
  if (!channel) {
    return;
  }
  mojo::AssociatedRemote<mojom::NNRendererConfig> config;
  channel->GetRemoteAssociatedInterface(&config);
  config->SetPageScript(Script());
}

void SetBoosts(std::vector<Boost> boosts) {
  BoostList() = std::move(boosts);
  for (auto it = content::RenderProcessHost::AllHostsIterator(); !it.IsAtEnd();
       it.Advance()) {
    content::RenderProcessHost* host = it.GetCurrentValue();
    if (host->IsInitializedAndNotDead()) {
      SendBoosts(host);
    }
  }
  // Pages whose inversion changed get their web preferences again (only those: it restyles
  // the whole page).
  for (content::WebContents* contents : AllContents()) {
    if (contents->GetOrCreateWebPreferences().force_dark_mode_enabled !=
        BoostInverts(contents)) {
      contents->OnWebPreferencesChanged();
    }
  }
}

void SendBoosts(content::RenderProcessHost* host) {
  IPC::ChannelProxy* channel = host->GetChannel();
  if (!channel) {
    return;
  }
  const bool off_the_record = host->GetBrowserContext()->IsOffTheRecord();
  std::vector<mojom::NNBoostPtr> boosts;
  for (const Boost& boost : BoostList()) {
    const bool script = !off_the_record || boost.script_in_private;
    boosts.push_back(mojom::NNBoost::New(boost.host, boost.user_css, boost.css,
                                         script ? boost.script : std::string()));
  }
  mojo::AssociatedRemote<mojom::NNRendererConfig> config;
  channel->GetRemoteAssociatedInterface(&config);
  config->SetBoosts(std::move(boosts));
}

bool BoostInverts(content::WebContents* contents) {
  const std::string host =
      BoostHost(contents->GetPrimaryMainFrame()->GetLastCommittedURL());
  if (host.empty()) {
    return false;
  }
  for (const Boost& boost : BoostList()) {
    if (boost.host == host && boost.invert) {
      return true;
    }
  }
  return false;
}

void RegisterPageChannelBinders(content::RenderFrameHost& render_frame_host,
                                blink::AssociatedInterfaceRegistry& registry) {
  registry.AddInterface<mojom::NNPageHost>(base::BindRepeating(
      [](content::RenderFrameHost* frame,
         mojo::PendingAssociatedReceiver<mojom::NNPageHost> receiver) {
        content::WebContents* contents =
            content::WebContents::FromRenderFrameHost(frame);
        if (contents) {
          PageChannel::GetOrCreate(contents)->Bind(frame, std::move(receiver));
        }
      },
      &render_frame_host));
}

void AddAppSchemeThrottle(content::NavigationThrottleRegistry& registry) {
  registry.AddThrottle(std::make_unique<AppSchemeThrottle>(registry));
}

// --- PageChannel
// --------------------------------------------------------------------------

PageChannel::PageChannel(content::WebContents* contents)
    : content::WebContentsObserver(contents),
      content::WebContentsUserData<PageChannel>(*contents),
      receivers_(contents, this) {}

void PageChannel::PrimaryPageChanged(content::Page& page) {
  // The old document's pending evaluations get no answer (it may sit in the
  // back/forward cache, timers frozen, and answer much later otherwise).
  main_page_.reset();
}

void PageChannel::ReadyToCommitNavigation(
    content::NavigationHandle* navigation) {
  // Send the serialized palette and all host tints before document start or BFCache
  // activation, including an empty descriptor that clears stale state in a reused frame.
  if (!navigation->IsInPrimaryMainFrame() ||
      navigation->IsSameDocument()) {
    return;
  }
  if (auto page = PageOf(navigation->GetRenderFrameHost())) {
    page->SetBoostStyle(boost_style_);
  }
}

void PageChannel::SetBoostStyle(const std::string& descriptor) {
  if (boost_style_ == descriptor) {
    return;
  }
  boost_style_ = descriptor;
  if (mojom::NNPage* page = MainPage()) {
    page->SetBoostStyle(descriptor);
  }
}

PageChannel::~PageChannel() = default;

// static
PageChannel* PageChannel::GetOrCreate(content::WebContents* contents) {
  CreateForWebContents(contents);
  return FromWebContents(contents);
}

// static
std::string PageChannel::FrameId(content::RenderFrameHost* frame) {
  const content::GlobalRenderFrameHostId id = frame->GetGlobalId();
  return base::StrCat({base::NumberToString(id.child_id.GetUnsafeValue()), ":",
                       base::NumberToString(id.frame_routing_id)});
}

void PageChannel::Bind(
    content::RenderFrameHost* frame,
    mojo::PendingAssociatedReceiver<mojom::NNPageHost> receiver) {
  receivers_.Bind(frame, std::move(receiver));
}

void PageChannel::Post(const std::string& kind, const std::string& json) {
  content::RenderFrameHost& frame = receivers_.CurrentTargetFrame();
  DeliverPageMessage(&GetWebContents(), kind, json, FrameId(&frame),
                     frame.IsInPrimaryMainFrame());
}

mojom::NNPage* PageChannel::MainPage() {
  content::RenderFrameHost* frame = GetWebContents().GetPrimaryMainFrame();
  if (!frame->IsRenderFrameLive()) {
    return nullptr;
  }
  if (!main_page_.is_bound() || !main_page_.is_connected() ||
      main_page_frame_ != frame->GetGlobalId()) {
    // A new document's calls go to its frame (an evaluation pending on the old
    // one gets no answer).
    main_page_.reset();
    frame->GetRemoteAssociatedInterfaces()->GetInterface(&main_page_);
    main_page_frame_ = frame->GetGlobalId();
  }
  return main_page_.get();
}

void PageChannel::CallPage(const std::string& kind, const std::string& json) {
  if (mojom::NNPage* page = MainPage()) {
    page->CallPage(kind, json);
  }
}

content::RenderFrameHost* PageChannel::FindFrame(const std::string& frame_id) {
  content::RenderFrameHost* target = nullptr;
  GetWebContents().GetPrimaryMainFrame()->ForEachRenderFrameHost(
      [&](content::RenderFrameHost* frame) {
        if (!target && FrameId(frame) == frame_id) {
          target = frame;
        }
      });
  return target;
}

void PageChannel::ExecuteInFrame(const std::string& frame_id,
                                 const std::string& code) {
  content::RenderFrameHost* target = FindFrame(frame_id);
  if (!target) {
    return;
  }
  if (target->IsInPrimaryMainFrame()) {
    Execute(code);
  } else if (auto page = PageOf(target)) {
    page->Execute(code, /*user_gesture=*/false);
  }
}

void PageChannel::CallFrame(const std::string& frame_id,
                            const std::string& kind,
                            const std::string& json) {
  content::RenderFrameHost* target = FindFrame(frame_id);
  if (!target) {
    return;
  }
  if (target->IsInPrimaryMainFrame()) {
    CallPage(kind, json);
  } else if (auto page = PageOf(target)) {
    page->CallPage(kind, json);
  }
}

void PageChannel::Execute(const std::string& code, bool user_gesture) {
  if (mojom::NNPage* page = MainPage()) {
    page->Execute(code, user_gesture);
  }
}

void PageChannel::Evaluate(
    const std::string& code,
    bool user_gesture,
    base::OnceCallback<void(const std::optional<std::string>&)> callback) {
  // No answer when the frame (or the renderer) goes before it answers.
  // Always on a later turn: the default answer runs when the remote goes, which
  // can be in the middle of this object's work (and the host may close the tab
  // from its completion).
  auto answer = mojo::WrapCallbackWithDefaultInvokeIfNotRun(
      base::BindPostTaskToCurrentDefault(std::move(callback)), std::nullopt);
  mojom::NNPage* page = MainPage();
  if (!page) {
    std::move(answer).Run(std::nullopt);
    return;
  }
  page->Evaluate(code, user_gesture, std::move(answer));
}

WEB_CONTENTS_USER_DATA_KEY_IMPL(PageChannel);

}  // namespace nncore
