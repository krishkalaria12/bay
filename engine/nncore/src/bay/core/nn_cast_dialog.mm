// The macOS host's side of the shared Cast dialog (nn_cast_dialogs.cc): the
// cef::WantsCastDialog / HandleCastDialog seams, the host's dictionaries and a profile's
// Cast routes.

#include "bay/core/nn_cast_dialog.h"

#import <Foundation/Foundation.h>

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/scoped_observation.h"
#include "base/strings/sys_string_conversions.h"
#include "base/values.h"
#include "chrome/browser/media/router/media_router_feature.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_observer.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "components/media_router/browser/media_router.h"
#include "components/media_router/browser/media_router_dialog_controller.h"
#include "components/media_router/browser/media_router_factory.h"
#include "components/media_router/browser/media_router_metrics.h"
#include "components/media_router/browser/media_routes_observer.h"
#include "components/media_router/common/media_route.h"
#include "content/public/browser/web_contents.h"
#include "bay/core/nn_browser.h"
#include "bay/core/nn_cast_dialogs.h"
#include "bay/core/nn_mac_values.h"
#include "bay/core/nn_test_media_route_provider.h"

namespace nncore {

namespace {

bool IsHostTab(content::WebContents* contents) {
  BrowserWindowInterface* browser =
      contents ? GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(contents)
               : nullptr;
  return browser && WindowHost::ForBrowser(browser);
}

// A profile's Cast routes (what it casts now), for the host (JS onCastRoutes).
class RoutesWatcher : public media_router::MediaRoutesObserver,
                      public ProfileObserver {
 public:
  RoutesWatcher(media_router::MediaRouter* router, Profile* profile)
      : media_router::MediaRoutesObserver(router), profile_(profile) {
    profile_observation_.Observe(profile);
  }

  void OnRoutesUpdated(const std::vector<media_router::MediaRoute>& routes) override {
    NSMutableArray* list = [NSMutableArray array];
    for (const auto& route : routes) {
      [list addObject:@{
        @"id" : base::SysUTF8ToNSString(route.media_route_id()),
        @"sink" : base::SysUTF8ToNSString(route.media_sink_id()),
        @"description" : base::SysUTF8ToNSString(route.description()),
        @"source" : base::SysUTF8ToNSString(route.media_source().id()),
      }];
    }
    HostCastRoutes(profile_, list);
  }

  // Before its keyed services (the router) go.
  void OnProfileWillBeDestroyed(Profile* profile) override;

  media_router::MediaRouter* media_router() const { return router(); }

 private:
  raw_ptr<Profile> profile_;
  base::ScopedObservation<Profile, ProfileObserver> profile_observation_{this};
};

std::map<Profile*, std::unique_ptr<RoutesWatcher>>& Watchers() {
  static base::NoDestructor<std::map<Profile*, std::unique_ptr<RoutesWatcher>>> watchers;
  return *watchers;
}

void RoutesWatcher::OnProfileWillBeDestroyed(Profile* profile) {
  profile_observation_.Reset();
  Watchers().erase(profile);  // Destroys this.
}

}  // namespace

void WatchCastRoutes(Profile* profile) {
  // Test runs: before any dialog asks for sinks (the host watches each profile at startup).
  MaybeRegisterTestMediaRouteProvider(profile);
  if (!profile || Watchers().contains(profile) ||
      !media_router::MediaRouterEnabled(profile)) {
    return;
  }
  media_router::MediaRouter* router =
      media_router::MediaRouterFactory::GetApiForBrowserContext(profile);
  if (!router) {
    return;
  }
  Watchers()[profile] = std::make_unique<RoutesWatcher>(router, profile);
  // The routes now (the observer hears only changes).
  Watchers()[profile]->OnRoutesUpdated(router->GetCurrentRoutes());
}

void TerminateCastRoute(const std::string& route_id) {
  for (auto& [profile, watcher] : Watchers()) {
    for (const auto& route : watcher->media_router()->GetCurrentRoutes()) {
      if (route.media_route_id() == route_id) {
        watcher->media_router()->TerminateRoute(route_id);
        return;
      }
    }
  }
}

bool WantsCastDialog(content::WebContents* initiator) {
  return HostWantsCastDialogs() && IsHostTab(initiator);
}

bool HandleCastDialog(content::WebContents* initiator,
                      media_router::MediaRouterUI* ui) {
  if (!ui || !WantsCastDialog(initiator)) {
    return false;
  }
  static bool told = [] {
    cast::SetTell(base::BindRepeating([](content::WebContents* initiator,
                                         base::DictValue state) {
      HostCastDialog(initiator, NSDictionaryFrom(state));
      return true;
    }));
    return true;
  }();
  (void)told;
  cast::Adopt(initiator, ui);
  return true;
}

bool ShowCastDialog(content::WebContents* contents) {
  if (!contents || !media_router::MediaRouterEnabled(contents->GetBrowserContext())) {
    return false;
  }
  MaybeRegisterTestMediaRouteProvider(
      Profile::FromBrowserContext(contents->GetBrowserContext()));
  media_router::MediaRouterDialogController::GetOrCreateForWebContents(contents)
      ->ShowMediaRouterDialog(
          media_router::MediaRouterDialogActivationLocation::TOOLBAR);
  return true;
}

void StartCasting(int dialog_id, const std::string& sink_id, int cast_mode) {
  cast::StartCasting(dialog_id, sink_id, cast_mode);
}

void StopCasting(int dialog_id, const std::string& route_id) {
  cast::StopCasting(dialog_id, route_id);
}

void CloseCastDialog(int dialog_id) {
  cast::Close(dialog_id);
}

}  // namespace nncore
