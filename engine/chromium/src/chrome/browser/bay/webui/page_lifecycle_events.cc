// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/page_lifecycle_events.h"

#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/task/single_thread_task_runner.h"
#include "build/build_config.h"
#include "chrome/browser/bay/webui/tab_broker.h"
#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_user_data.h"
#include "url/gurl.h"

// Defined by chromium-bay-page-activation.patch.
#if BUILDFLAG(IS_WIN) || BUILDFLAG(IS_LINUX)
extern bool (*g_bay_activate_contents)(content::WebContents*);
#endif

namespace bay {
namespace {
PageLifecycleEvents::ViewSink& Sink() {
  static base::NoDestructor<PageLifecycleEvents::ViewSink> sink;
  return *sink;
}
class PendingActivation
    : public content::WebContentsUserData<PendingActivation> {
 public:
  bool pending = false;
 private:
  explicit PendingActivation(content::WebContents* contents)
      : content::WebContentsUserData<PendingActivation>(*contents) {}
  friend content::WebContentsUserData<PendingActivation>;
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};
WEB_CONTENTS_USER_DATA_KEY_IMPL(PendingActivation);
const char* Disposition(WindowOpenDisposition disposition) {
  switch (disposition) {
    case WindowOpenDisposition::NEW_FOREGROUND_TAB:
    case WindowOpenDisposition::SINGLETON_TAB:
    case WindowOpenDisposition::SWITCH_TO_TAB: return "foreground";
    case WindowOpenDisposition::NEW_BACKGROUND_TAB: return "background";
    case WindowOpenDisposition::NEW_WINDOW: return "window";
    case WindowOpenDisposition::NEW_POPUP: return "popup";
    case WindowOpenDisposition::OFF_THE_RECORD: return "incognito";
    case WindowOpenDisposition::NEW_SPLIT_VIEW: return "split";
    default: return nullptr;
  }
}
}  // namespace

void PageLifecycleEvents::Start(ViewSink sink) {
  Sink() = std::move(sink);
#if BUILDFLAG(IS_WIN) || BUILDFLAG(IS_LINUX)
  g_bay_activate_contents = &PageLifecycleEvents::RequestActivation;
#endif
}
bool PageLifecycleEvents::RequestActivation(content::WebContents* contents) {
  if (!contents || !Sink())
    return false;
  if (auto* pending = PendingActivation::FromWebContents(contents))
    pending->pending = false;
  auto weak = contents->GetWeakPtr();
  auto sink = Sink();
  if (sink.Run(contents, "onActivateRequest",
                base::DictValue().Set("reason", "page")))
    return true;
  // A synchronous sink may close the page. Never return it to Chrome's
  // activation code after its destruction.
  if (!weak)
    return true;
  if (!TabBroker::Get().Tracks(contents))
    return false;
  PendingActivation::CreateForWebContents(contents);
  PendingActivation::FromWebContents(contents)->pending = true;
  return true;
}
void PageLifecycleEvents::Replay(content::WebContents* contents) {
  if (!contents)
    return;
  auto* pending = PendingActivation::FromWebContents(contents);
  if (!pending || !pending->pending || !Sink())
    return;
  pending->pending = false;
  RequestActivation(contents);
}
bool PageLifecycleEvents::HandleEngineEvent(
    std::string_view topic, const base::DictValue& payload) {
  if (topic != "tabs.appURL")
    return false;
  const auto id = payload.FindInt("browserId");
  const auto* profile_path = payload.FindString("profile");
  const auto* requested = payload.FindString("url");
  if (!id || *id <= 0 || !profile_path || !requested || !Sink())
    return true;
  auto* contents = TabBroker::Get().ContentsForBrowserId(*id);
  if (!contents)
    return true;
  auto* profile = Profile::FromBrowserContext(contents->GetBrowserContext());
  const GURL url(*requested);
  const GURL& source = contents->GetLastCommittedURL();
  // The throttle only forwards Bay links from Chrome's own pages. Recheck
  // the page and profile because this event crosses two posted tasks.
  if (!profile || profile->GetOriginalProfile()->GetPath().AsUTF8Unsafe() !=
                      *profile_path ||
      !url.is_valid() || !url.SchemeIs("bay") ||
      !(source.SchemeIs("chrome") || source.SchemeIs("devtools")))
    return true;
  auto sink = Sink();
  sink.Run(contents, "onOpenWindow",
           base::DictValue()
               .Set("url", url.spec())
               .Set("disposition", "current")
               .Set("userGesture",
                    payload.FindBool("userGesture").value_or(false)));
  return true;
}
void PageLifecycleEvents::OpenRequestedURL(
    content::WebContents* source, content::WebContents* opened, const GURL& url,
    WindowOpenDisposition disposition, bool user_gesture) {
  const char* intent = Disposition(disposition);
  if (!source || !opened || source == opened || !intent || !url.is_valid() ||
      url.SchemeIs("javascript") || url.SchemeIs("bay") ||
      source->GetBrowserContext() != opened->GetBrowserContext() || !Sink() ||
      !TabBroker::Get().HasPageKey(source))
    return;
  // An extension view with no application tab key keeps Chrome's popup path.
  // The source's normal app view always subscribes to onOpenWindow.
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(
          [](base::WeakPtr<content::WebContents> source,
             base::WeakPtr<content::WebContents> opened, GURL url,
             std::string intent, bool gesture) {
            if (!source || !opened || !Sink())
              return;
            auto offer = TabBroker::Get().Offer(opened.get());
            if (offer.adopt_id.empty())
              return;
            auto sink = Sink();
            if (!sink.Run(source.get(), "onOpenWindow",
                          base::DictValue()
                              .Set("url", url.spec())
                              .Set("disposition", std::move(intent))
                              .Set("adoptId", offer.adopt_id)
                              .Set("userGesture", gesture)))
              TabBroker::Get().ReleaseOffer(offer.adopt_id);
          }, source->GetWeakPtr(), opened->GetWeakPtr(), url,
          std::string(intent), user_gesture));
}
}  // namespace bay
