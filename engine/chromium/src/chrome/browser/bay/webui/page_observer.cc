// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/page_observer.h"

#include <utility>

#include "base/strings/utf_string_conversions.h"
#include "chrome/browser/bay/webui/native_host.h"
#include "chrome/browser/bay/webui/tab_broker.h"
#include "components/sessions/content/session_tab_helper.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/web_contents.h"

namespace bay {
TabObserver::TabObserver(content::WebContents* contents,
                         int tag,
                         uint64_t lease,
                         std::optional<std::string> requested_url,
                         base::WeakPtr<NativeHost> host)
    : WebContentsObserver(contents),
      tag_(tag),
      lease_(lease),
      requested_url_(std::move(requested_url)),
      host_(std::move(host)) {}
TabObserver::~TabObserver() = default;
content::WebContents* TabObserver::contents() const {
  return web_contents();
}
uint64_t TabObserver::lease() const {
  return lease_;
}
const std::optional<std::string>& TabObserver::requested_url() const {
  return requested_url_;
}
void TabObserver::set_requested_url(std::optional<std::string> url) {
  requested_url_ = std::move(url);
}
bool TabObserver::current() const {
  return TabBroker::Get().IsCurrent(web_contents(), lease_);
}
void TabObserver::State() {
  if (!host_ || !web_contents() || !current())
    return;
  auto* contents = web_contents();
  auto& navigation = contents->GetController();
  host_->ViewEvent(
      tag_, "onNavigationChange",
      base::DictValue()
          .Set("browserId", sessions::SessionTabHelper::IdForTab(contents).id())
          .Set("url", contents->GetVisibleURL().spec())
          .Set("title", base::UTF16ToUTF8(contents->GetTitle()))
          .Set("isLoading", contents->IsLoading())
          .Set("themeColor", base::Value())
          .Set("themeColorSource", base::Value())
          .Set("canGoBack", navigation.CanGoBack())
          .Set("canGoForward", navigation.CanGoForward())
          .Set("audible", contents->IsCurrentlyAudible())
          .Set("muted", contents->IsAudioMuted()));
}
void TabObserver::TitleWasSet(content::NavigationEntry*) {
  State();
}
void TabObserver::DidStartLoading() {
  State();
}
void TabObserver::DidStopLoading() {
  State();
}
void TabObserver::DidFinishNavigation(content::NavigationHandle* handle) {
  if (handle->IsInPrimaryMainFrame())
    State();
}
void TabObserver::OnAudioStateChanged(bool) {
  Media();
}
void TabObserver::DidUpdateAudioMutingState(bool) {
  Media();
}
void TabObserver::Media() {
  if (host_ && web_contents() && current())
    host_->ViewEvent(tag_, "onMedia",
                     base::DictValue()
                         .Set("playing", web_contents()->IsCurrentlyAudible())
                         .Set("muted", web_contents()->IsAudioMuted()));
}
void TabObserver::WebContentsDestroyed() {
  if (host_ && TabBroker::Get().IsLastLease(web_contents(), lease_))
    host_->ViewEvent(tag_, "onWindowClose", base::DictValue());
}
}  // namespace bay
