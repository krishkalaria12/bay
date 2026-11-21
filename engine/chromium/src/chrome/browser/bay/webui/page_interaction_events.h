// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_PAGE_INTERACTION_EVENTS_H_
#define CHROME_BROWSER_BAY_WEBUI_PAGE_INTERACTION_EVENTS_H_

#include <set>
#include <string>

#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/scoped_observation.h"
#include "base/values.h"
#include "components/blocked_content/url_list_manager.h"
#include "content/public/browser/web_contents_observer.h"
#include "ui/base/page_transition_types.h"

class GURL;
namespace content {
class NavigationHandle;
class NavigationThrottleRegistry;
class WebContents;
}
namespace bay {

// Hover text, retained blocked-popup requests and the pinned-tab Peek rule.
// One instance follows each TabObserver's event sink. The Peek setting belongs
// to WebContents, so a mounted-view handoff does not reset the retained page.
class PageInteractionEvents final
    : public content::WebContentsObserver,
      public blocked_content::UrlListManager::Observer {
 public:
  using EventSink =
      base::RepeatingCallback<void(const char*, base::DictValue)>;
  using Response = base::OnceCallback<void(const std::string&)>;
  PageInteractionEvents(content::WebContents* contents, EventSink sink);
  ~PageInteractionEvents() override;
  void State();
  static void SetPeekLinks(content::WebContents* contents, bool enabled);
  static bool PeekLinksEnabled(content::WebContents* contents);
  static bool TargetURL(content::WebContents* contents, const GURL& url);
  static bool Dispatch(content::WebContents* contents,
                       const std::string& command,
                       const base::ListValue& params,
                       Response& response);
  static bool IsPeekNavigation(bool primary,
                               bool renderer_initiated,
                               bool user_gesture,
                               ui::PageTransition transition);
  static bool CrossSitePeekURL(const GURL& from, const GURL& to);

 private:
  friend void AddPageInteractionThrottles(content::NavigationThrottleRegistry& registry);
  void EmitPeek(const GURL& url);
  void BlockedUrlAdded(int32_t id, const GURL& url) override;
  void ReportPopup(int32_t id, const GURL& url, const std::string& origin);
  void DidFinishNavigation(content::NavigationHandle* navigation) override;
  void WebContentsDestroyed() override;
  void Detach();
  void Status(const std::string& text);
  EventSink sink_;
  bool initial_status_ = false;
  std::string status_;
  std::set<int32_t> reported_popups_;
  base::ScopedObservation<blocked_content::UrlListManager,
                          blocked_content::UrlListManager::Observer>
      popups_{this};
  base::WeakPtrFactory<PageInteractionEvents> weak_factory_{this};
};

// Called by chromium-page-interactions-webui.patch. Chrome's content browser
// client only calls this for the two desktop WebUI hosts.
void AddPageInteractionThrottles(content::NavigationThrottleRegistry& registry);
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_PAGE_INTERACTION_EVENTS_H_
