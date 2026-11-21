// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/page_interaction_events.h"

#include <algorithm>
#include <map>
#include <memory>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "build/build_config.h"
#include "chrome/browser/content_settings/host_content_settings_map_factory.h"
#include "components/blocked_content/popup_blocker_tab_helper.h"
#include "components/content_settings/core/browser/host_content_settings_map.h"
#include "components/content_settings/core/common/content_settings.h"
#include "components/content_settings/core/common/content_settings_types.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_user_data.h"
#include "content/public/browser/weak_document_ptr.h"
#include "net/base/registry_controlled_domains/registry_controlled_domain.h"
#include "ui/base/window_open_disposition.h"
#include "url/gurl.h"
#include "url/origin.h"

#if BUILDFLAG(IS_WIN) || BUILDFLAG(IS_LINUX)
// Defined in BrowserWebContentsDelegate by the companion Chromium patch.
extern bool (*g_bay_page_target_url)(content::WebContents*, const GURL&);
#endif

namespace bay {
namespace {
class InteractionState final
    : public content::WebContentsUserData<InteractionState> {
 public:
  static InteractionState& Get(content::WebContents* contents) {
    CreateForWebContents(contents);
    return *FromWebContents(contents);
  }
  bool peek_links = false;
  std::string status;
 private:
  friend class content::WebContentsUserData<InteractionState>;
  explicit InteractionState(content::WebContents* contents)
      : WebContentsUserData(*contents) {}
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};
WEB_CONTENTS_USER_DATA_KEY_IMPL(InteractionState);
using Observers = std::vector<base::WeakPtr<PageInteractionEvents>>;
std::map<content::WebContents*, Observers>& Instances() {
  static base::NoDestructor<std::map<content::WebContents*, Observers>> instances;
  return *instances;
}
Observers List(content::WebContents* contents) {
  const auto found = Instances().find(contents);
  return found == Instances().end() ? Observers() : found->second;
}
std::string Success() { return R"({"value":null})"; }
std::string Failure(const char* message) {
  return base::WriteJson(base::DictValue().Set(
      "error", base::DictValue().Set("code", "invalid_args")
                                .Set("message", message))).value_or("{}");
}
class PeekLinksThrottle final : public content::NavigationThrottle {
 public:
  PeekLinksThrottle(content::NavigationThrottleRegistry& registry,
                     base::RepeatingCallback<void(GURL)> report)
      : NavigationThrottle(registry), report_(std::move(report)) {}
  ThrottleCheckResult WillStartRequest() override { return Check(); }
  ThrottleCheckResult WillRedirectRequest() override { return Check(); }
  const char* GetNameForLogging() override { return "BayPeekLinksThrottle"; }
 private:
  ThrottleCheckResult Check() {
    auto* contents = navigation_handle()->GetWebContents();
    const GURL& from = contents->GetPrimaryMainFrame()->GetLastCommittedURL();
    const GURL& to = navigation_handle()->GetURL();
    if (!PageInteractionEvents::PeekLinksEnabled(contents) ||
        !PageInteractionEvents::CrossSitePeekURL(from, to))
      return PROCEED;
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(report_, to));
    return CANCEL_AND_IGNORE;
  }
  base::RepeatingCallback<void(GURL)> report_;
};
}  // namespace

PageInteractionEvents::PageInteractionEvents(content::WebContents* contents,
                                               EventSink sink)
    : WebContentsObserver(contents), sink_(std::move(sink)) {
  InteractionState::Get(contents);
  Instances()[contents].push_back(weak_factory_.GetWeakPtr());
#if BUILDFLAG(IS_WIN) || BUILDFLAG(IS_LINUX)
  g_bay_page_target_url = &TargetURL;
#endif
}
PageInteractionEvents::~PageInteractionEvents() { Detach(); }
void PageInteractionEvents::Detach() {
  popups_.Reset();
  if (auto* contents = web_contents()) {
    auto found = Instances().find(contents);
    if (found != Instances().end()) {
      std::erase_if(found->second, [this](const auto& observer) {
        return !observer || observer.get() == this;
      });
      if (found->second.empty())
        Instances().erase(found);
    }
  }
  weak_factory_.InvalidateWeakPtrs();
}
void PageInteractionEvents::WebContentsDestroyed() { Detach(); }
void PageInteractionEvents::SetPeekLinks(content::WebContents* contents,
                                         bool enabled) {
  if (contents)
    InteractionState::Get(contents).peek_links = enabled;
}
bool PageInteractionEvents::PeekLinksEnabled(content::WebContents* contents) {
  const auto* state = contents ? InteractionState::FromWebContents(contents) : nullptr;
  return state && state->peek_links && !List(contents).empty();
}
bool PageInteractionEvents::TargetURL(content::WebContents* contents,
                                      const GURL& url) {
  const auto observers = List(contents);
  if (observers.empty())
    return false;
  InteractionState::Get(contents).status = url.spec();
  for (const auto& observer : observers)
    if (observer)
      observer->Status(url.spec());
  return true;
}
void PageInteractionEvents::EmitPeek(const GURL& url) {
  sink_.Run("onPeekLink", base::DictValue().Set("url", url.spec()));
}
void PageInteractionEvents::Status(const std::string& text) {
  if (initial_status_ && status_ == text)
    return;
  initial_status_ = true;
  status_ = text;
  sink_.Run("onStatus", base::DictValue().Set("text", text));
}
void PageInteractionEvents::State() {
  if (!web_contents())
    return;
  const auto weak = weak_factory_.GetWeakPtr();
  Status(InteractionState::Get(web_contents()).status);
  if (!weak)
    return;
  auto* helper = blocked_content::PopupBlockerTabHelper::FromWebContents(web_contents());
  if (!helper)
    return;
  if (!popups_.IsObserving())
    popups_.Observe(helper->manager());
  for (const auto& [id, url] : helper->GetBlockedPopupRequests())
    BlockedUrlAdded(id, url);
}
void PageInteractionEvents::BlockedUrlAdded(int32_t id, const GURL& url) {
  if (!web_contents() || !reported_popups_.insert(id).second)
    return;
  const auto origin = web_contents()->GetPrimaryMainFrame()
                          ->GetLastCommittedOrigin().Serialize();
  // The helper is still finishing AddBlockedPopup; a user may open it as soon
  // as the event arrives, so never run that command from inside its callback.
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&PageInteractionEvents::ReportPopup,
                                weak_factory_.GetWeakPtr(), id, url, origin));
}
void PageInteractionEvents::ReportPopup(int32_t id,
                                        const GURL& url,
                                        const std::string& origin) {
  auto* helper = web_contents()
                     ? blocked_content::PopupBlockerTabHelper::FromWebContents(web_contents())
                     : nullptr;
  if (!helper || !helper->GetBlockedPopupRequests().contains(id))
    return;
  sink_.Run("onPopupBlocked", base::DictValue()
                                    .Set("id", base::NumberToString(id))
                                    .Set("url", url.spec())
                                    .Set("origin", origin));
}
void PageInteractionEvents::DidFinishNavigation(content::NavigationHandle* handle) {
  if (!handle->IsInPrimaryMainFrame() || !handle->HasCommitted() ||
      handle->IsSameDocument())
    return;
  reported_popups_.clear();
  // The page's old hover target must not linger after navigation.
  TargetURL(web_contents(), GURL());
}
bool PageInteractionEvents::IsPeekNavigation(
    bool primary, bool renderer_initiated, bool user_gesture,
    ui::PageTransition transition) {
  return primary && renderer_initiated && user_gesture &&
         ui::PageTransitionCoreTypeIs(transition, ui::PAGE_TRANSITION_LINK) &&
         !(transition & ui::PAGE_TRANSITION_FORWARD_BACK);
}
bool PageInteractionEvents::CrossSitePeekURL(const GURL& from, const GURL& to) {
  return from.SchemeIsHTTPOrHTTPS() && to.SchemeIsHTTPOrHTTPS() &&
         !net::registry_controlled_domains::SameDomainOrHost(
             from, to, net::registry_controlled_domains::INCLUDE_PRIVATE_REGISTRIES);
}
bool PageInteractionEvents::Dispatch(content::WebContents* contents,
                                      const std::string& command,
                                      const base::ListValue& params,
                                      Response& response) {
  if (command != "openBlockedPopup")
    return false;
  if (params.empty() || params.size() > 2 || !params[0].is_string() ||
      (params.size() == 2 && !params[1].is_none() && !params[1].is_bool())) {
    std::move(response).Run(Failure("A popup id and optional allow flag are required"));
    return true;
  }
  int32_t id;
  auto* helper = blocked_content::PopupBlockerTabHelper::FromWebContents(contents);
  if (!helper || !base::StringToInt(params[0].GetString(), &id) ||
      !helper->GetBlockedPopupRequests().contains(id)) {
    std::move(response).Run(Success());
    return true;
  }
  if (params.size() == 2 && params[1].is_bool() && params[1].GetBool()) {
    HostContentSettingsMapFactory::GetForProfile(contents->GetBrowserContext())
        ->SetContentSettingDefaultScope(contents->GetLastCommittedURL(), GURL(),
                                        ContentSettingsType::POPUPS,
                                        CONTENT_SETTING_ALLOW);
  }
  helper->ShowBlockedPopup(id, WindowOpenDisposition::NEW_FOREGROUND_TAB);
  std::move(response).Run(Success());
  return true;
}
void AddPageInteractionThrottles(content::NavigationThrottleRegistry& registry) {
  auto& handle = registry.GetNavigationHandle();
  auto* contents = handle.GetWebContents();
  if (!PageInteractionEvents::IsPeekNavigation(
          handle.IsInPrimaryMainFrame(), handle.IsRendererInitiated(),
          handle.HasUserGesture(), handle.GetPageTransition()) ||
      !PageInteractionEvents::PeekLinksEnabled(contents))
    return;
  registry.AddThrottle(std::make_unique<PeekLinksThrottle>(
      registry, base::BindRepeating(
          [](base::WeakPtr<content::WebContents> contents,
             content::WeakDocumentPtr document, GURL url) {
            if (!contents || !document.AsRenderFrameHostIfValid() ||
                contents->GetPrimaryMainFrame() != document.AsRenderFrameHostIfValid() ||
                !PageInteractionEvents::PeekLinksEnabled(contents.get()))
              return;
            for (const auto& observer : List(contents.get()))
              if (observer)
                observer->EmitPeek(url);
          }, contents->GetWeakPtr(),
          contents->GetPrimaryMainFrame()->GetWeakDocumentPtr())));
}
}  // namespace bay
