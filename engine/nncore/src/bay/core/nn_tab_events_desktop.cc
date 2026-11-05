// Copyright 2026 Bay. Apache-2.0.
#include "bay/core/nn_tab_events.h"

#include "base/logging.h"
#include "chrome/browser/bay/nn_engine.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface_iterator.h"
#include "components/sessions/content/session_tab_helper.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_user_data.h"
#include "ui/base/base_window.h"
#include "url/gurl.h"

namespace nncore {
namespace {
class TabEvents : public content::WebContentsUserData<TabEvents> {
 public:
  bool closed_by_host = false;
  bool will_close_reported = false;

 private:
  explicit TabEvents(content::WebContents* contents)
      : content::WebContentsUserData<TabEvents>(*contents) {}
  friend content::WebContentsUserData<TabEvents>;
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};
WEB_CONTENTS_USER_DATA_KEY_IMPL(TabEvents);

void Emit(content::WebContents* contents,
          const char* topic,
          base::DictValue payload) {
  if (!contents)
    return;
  payload.Set("browserId", sessions::SessionTabHelper::IdForTab(contents).id());
  bay::Emit(topic, Profile::FromBrowserContext(contents->GetBrowserContext()),
            std::move(payload));
}
}  // namespace

void EnsureTabBridge(content::WebContents* contents) {
  if (!contents || TabEvents::FromWebContents(contents))
    return;
  TabEvents::CreateForWebContents(contents);
}
void ReportTabWillClose(content::WebContents* contents) {
  if (!contents)
    return;
  EnsureTabBridge(contents);
  auto* events = TabEvents::FromWebContents(contents);
  if (events->closed_by_host || events->will_close_reported)
    return;
  events->will_close_reported = true;
  Emit(contents, "tabs.willClose", base::DictValue());
}
void MarkTabClosedByHost(content::WebContents* contents) {
  if (!contents)
    return;
  EnsureTabBridge(contents);
  TabEvents::FromWebContents(contents)->closed_by_host = true;
}
void ReportAppURLRequest(content::WebContents* contents,
                         const GURL& url,
                         bool user_gesture) {
  Emit(contents, "tabs.appURL",
       base::DictValue()
           .Set("url", url.spec())
           .Set("userGesture", user_gesture));
}
void DeliverPageMessage(content::WebContents* contents,
                        const std::string& kind,
                        const std::string& json,
                        const std::string& frame_id,
                        bool main_frame) {
  Emit(contents, "tabs.pageMessage",
       base::DictValue()
           .Set("kind", kind)
           .Set("json", json)
           .Set("frame", frame_id)
           .Set("main", main_frame));
}
content::WebContents* ShownHostPageForProfile(Profile* profile) {
  content::WebContents* found = nullptr;
  ForEachCurrentBrowserWindowInterfaceOrderedByActivation(
      [&](BrowserWindowInterface* browser) {
        auto* tab = browser->GetActiveTabInterface();
        if (browser->GetProfile() != profile ||
            !browser->GetWindow()->IsVisible() || !tab)
          return true;
        found = tab->GetContents();
        return false;
      });
  return found;
}
void LogNavigationHoldInfo(const std::string& message) {
  LOG(INFO) << message;
}
}  // namespace nncore
