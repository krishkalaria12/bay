// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/page_observer.h"

#include <algorithm>
#include <cmath>
#include <utility>

#include "base/strings/stringprintf.h"
#include "base/strings/utf_string_conversions.h"
#include "build/build_config.h"
#include "chrome/browser/bay/webui/native_host.h"
#include "chrome/browser/bay/webui/page_services.h"
#include "chrome/browser/bay/webui/tab_broker.h"
#include "components/favicon/content/content_favicon_driver.h"
#include "components/find_in_page/find_notification_details.h"
#include "components/find_in_page/find_tab_helper.h"
#include "components/sessions/content/session_tab_helper.h"
#include "content/public/browser/favicon_status.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "net/base/net_errors.h"
#include "third_party/blink/public/common/chrome_debug_urls.h"
#include "third_party/blink/public/common/page/page_zoom.h"
#include "third_party/blink/public/mojom/favicon/favicon_url.mojom.h"
#include "third_party/skia/include/core/SkColor.h"

namespace bay {
namespace {
const char* CrashReason(base::TerminationStatus status) {
  switch (status) {
    case base::TERMINATION_STATUS_ABNORMAL_TERMINATION:
      return "abnormal";
    case base::TERMINATION_STATUS_PROCESS_WAS_KILLED:
      return "killed";
    case base::TERMINATION_STATUS_PROCESS_CRASHED:
      return "crashed";
    case base::TERMINATION_STATUS_OOM:
      return "oom";
    case base::TERMINATION_STATUS_LAUNCH_FAILED:
      return "launchFailed";
#if BUILDFLAG(IS_WIN)
    case base::TERMINATION_STATUS_INTEGRITY_FAILURE:
      return "integrity";
#endif
    default:
      return "unknown";
  }
}
}  // namespace
TabObserver::TabObserver(content::WebContents* contents,
                         int tag,
                         uint64_t lease,
                         std::optional<std::string> requested_url,
                         base::WeakPtr<NativeHost> host)
    : WebContentsObserver(contents),
      tag_(tag),
      lease_(lease),
      requested_url_(std::move(requested_url)),
      host_(std::move(host)) {
  EnsureObservers();
}
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
bool TabObserver::CanEmit() const {
  return host_ && web_contents() && current();
}
void TabObserver::Emit(const char* event, base::DictValue payload) {
  if (CanEmit())
    host_->ViewEvent(tag_, event, std::move(payload));
}
void TabObserver::EnsureObservers() {
  if (!web_contents())
    return;
  if (!favicon_observation_.IsObserving()) {
    if (auto* driver =
            favicon::ContentFaviconDriver::FromWebContents(web_contents()))
      favicon_observation_.Observe(driver);
  }
  if (!find_observation_.IsObserving()) {
    if (auto* helper =
            find_in_page::FindTabHelper::FromWebContents(web_contents()))
      find_observation_.Observe(helper);
  }
  if (!zoom_observation_.IsObserving()) {
    if (auto* controller =
            zoom::ZoomController::FromWebContents(web_contents()))
      zoom_observation_.Observe(controller);
  }
}
base::DictValue TabObserver::NavigationState(const GURL& url) const {
  auto* contents = web_contents();
  auto& navigation = contents->GetController();
  auto theme = contents->GetThemeColor();
  const char* source = "meta";
  if (!theme || SkColorGetA(*theme) == 0) {
    theme = contents->GetBackgroundColor();
    source = "background";
  }
  const bool has_theme = theme && SkColorGetA(*theme) != 0;
  return base::DictValue()
      .Set("browserId", sessions::SessionTabHelper::IdForTab(contents).id())
      .Set("url", url.spec())
      .Set("title", base::UTF16ToUTF8(contents->GetTitle()))
      .Set("isLoading", contents->IsLoading())
      .Set("themeColor", has_theme
                             ? base::Value(base::StringPrintf(
                                   "#%02x%02x%02x", SkColorGetR(*theme),
                                   SkColorGetG(*theme), SkColorGetB(*theme)))
                             : base::Value())
      .Set("themeColorSource", has_theme ? base::Value(source) : base::Value())
      .Set("canGoBack", navigation.CanGoBack())
      .Set("canGoForward", navigation.CanGoForward())
      .Set("audible", contents->IsCurrentlyAudible())
      .Set("muted", contents->IsAudioMuted());
}
void TabObserver::State() {
  if (!CanEmit())
    return;
  EnsureObservers();
  // A debug URL can remain pending after killing its renderer. Persist the
  // real page so session restore cannot repeatedly crash the same tab.
  const auto& visible = web_contents()->GetVisibleURL();
  Emit("onNavigationChange",
       NavigationState(blink::IsRendererDebugURL(visible)
                           ? web_contents()->GetLastCommittedURL()
                           : visible));
  if (!std::exchange(initial_state_sent_, true)) {
    LoadProgressChanged(web_contents()->GetLoadProgress());
    Favicon();
    Zoom();
    Security();
    // A retained page may have crashed before this view acquired its lease.
    // Reconstruct the same crash event used for a newly lost renderer.
    if (web_contents()->IsCrashed())
      PrimaryMainFrameRenderProcessGone(web_contents()->GetCrashedStatus());
  }
}
void TabObserver::TitleWasSet(content::NavigationEntry*) {
  State();
}
void TabObserver::DidStartLoading() {
  if (CanEmit() && std::exchange(crashed_, false)) {
    // ContentCard dismisses a sad tab on a new page. Match the macOS host's
    // empty-then-current report when reloading the same page after a crash.
    Emit("onNavigationChange", NavigationState(GURL()));
  }
  State();
}
void TabObserver::DidStopLoading() {
  State();
  Security();
}
void TabObserver::LoadProgressChanged(double progress) {
  if (std::isfinite(progress))
    Emit("onProgress",
         base::DictValue().Set("progress", std::clamp(progress, 0.0, 1.0)));
}
void TabObserver::DidStartNavigation(content::NavigationHandle* handle) {
  if (handle->IsInPrimaryMainFrame() && !handle->IsSameDocument())
    last_load_error_.reset();
}
void TabObserver::DidFinishNavigation(content::NavigationHandle* handle) {
  if (!handle->IsInPrimaryMainFrame() || !CanEmit())
    return;
  if (handle->IsDownload()) {
    Emit("onDownloadNavigation",
         base::DictValue()
             .Set("url", handle->GetURL().spec())
             .Set("committedUrl", web_contents()->GetLastCommittedURL().spec())
             .Set("skipped", false));
  }
  State();
  LoadError(handle->GetURL(), handle->GetNetErrorCode());
  if (handle->HasCommitted()) {
    Favicon();
    Zoom();
    Security();
  }
}
void TabObserver::DidFailLoad(content::RenderFrameHost* frame,
                              const GURL& url,
                              int error_code) {
  if (web_contents() && frame == web_contents()->GetPrimaryMainFrame())
    LoadError(url, error_code);
}
void TabObserver::LoadError(const GURL& url, int code) {
  if (!CanEmit() || code == net::OK || code == net::ERR_ABORTED)
    return;
  const auto error = std::make_pair(url.spec(), code);
  if (last_load_error_ == error)
    return;
  last_load_error_ = error;
  Emit("onLoadError", base::DictValue()
                          .Set("url", url.spec())
                          .Set("code", code)
                          .Set("text", net::ErrorToString(code)));
}
void TabObserver::DidChangeThemeColor() {
  State();
}
void TabObserver::OnBackgroundColorChanged() {
  State();
}
void TabObserver::DidChangeVisibleSecurityState() {
  Security();
}
void TabObserver::Security() {
  if (!CanEmit())
    return;
  auto info = GetPageSecurityInfo(web_contents());
  if (last_security_ && *last_security_ == info)
    return;
  last_security_ = info.Clone();
  Emit("onSecurity", std::move(info));
}
void TabObserver::Favicon() {
  if (!CanEmit())
    return;
  auto* entry = web_contents()->GetController().GetLastCommittedEntry();
  if (!entry || !entry->GetFavicon().valid)
    return;
  base::ListValue candidates;
  for (const auto& candidate : web_contents()->GetFaviconURLs())
    if (candidate && candidate->icon_url.is_valid())
      candidates.Append(candidate->icon_url.spec());
  Emit("onFavicon", base::DictValue()
                        .Set("url", entry->GetFavicon().url.spec())
                        .Set("urls", std::move(candidates)));
}
void TabObserver::DidUpdateFaviconURL(
    content::RenderFrameHost* frame,
    const std::vector<blink::mojom::FaviconURLPtr>& candidates,
    blink::mojom::FaviconUpdateReason reason) {
  if (web_contents() && frame == web_contents()->GetPrimaryMainFrame())
    Favicon();
}
void TabObserver::OnFaviconUpdated(favicon::FaviconDriver* driver,
                                   NotificationIconType icon_type,
                                   const GURL& icon_url,
                                   bool icon_url_changed,
                                   const gfx::Image& image) {
  // The 16-DIP event updates the NavigationEntry's selected favicon. Other
  // sizes can arrive later and must not replace the browser's selected icon.
  if (icon_type == NON_TOUCH_16_DIP)
    Favicon();
}
void TabObserver::OnFindResultAvailable(content::WebContents* contents) {
  if (contents != web_contents() || !find_observation_.IsObserving())
    return;
  const auto& result = find_observation_.GetSource()->find_result();
  Emit("onFindResult", base::DictValue()
                           .Set("count", result.number_of_matches())
                           .Set("active", result.active_match_ordinal())
                           .Set("final", result.final_update()));
}
void TabObserver::OnFindEmptyText(content::WebContents* contents) {
  if (contents == web_contents())
    Emit("onFindResult",
         base::DictValue().Set("count", 0).Set("active", 0).Set("final", true));
}
void TabObserver::OnFindTabHelperDestroyed(
    find_in_page::FindTabHelper* helper) {
  find_observation_.Reset();
}
void TabObserver::Zoom() {
  if (!CanEmit() || !zoom_observation_.IsObserving())
    return;
  auto* controller = zoom_observation_.GetSource();
  const double factor =
      blink::ZoomLevelToZoomFactor(controller->GetZoomLevel());
  Emit("onZoom", base::DictValue()
                     .Set("zoom", std::round(factor * 100) / 100)
                     .Set("host", web_contents()->GetLastCommittedURL().host())
                     .Set("isDefault", controller->IsAtDefaultZoom())
                     .Set("pinchScale", pinch_scale_));
}
void TabObserver::OnZoomChanged(
    const zoom::ZoomController::ZoomChangedEventData& data) {
  if (data.web_contents == web_contents())
    Zoom();
}
void TabObserver::OnZoomControllerDestroyed(zoom::ZoomController* controller) {
  zoom_observation_.Reset();
}
void TabObserver::OnPageScaleFactorChanged(float scale) {
  if (std::isfinite(scale) && scale > 0) {
    pinch_scale_ = scale;
    Zoom();
  }
}
void TabObserver::PrimaryMainFrameRenderProcessGone(
    base::TerminationStatus status) {
  if (status == base::TERMINATION_STATUS_NORMAL_TERMINATION ||
      status == base::TERMINATION_STATUS_STILL_RUNNING || !CanEmit())
    return;
  crashed_ = true;
  Emit("onCrashed", base::DictValue()
                        .Set("status", static_cast<int>(status))
                        .Set("reason", CrashReason(status))
                        .Set("code", web_contents()->GetCrashedErrorCode()));
}
void TabObserver::OnRendererUnresponsive(content::RenderProcessHost* process) {
  if (web_contents() &&
      web_contents()->GetPrimaryMainFrame()->GetProcess() == process)
    Emit("onUnresponsive", base::DictValue());
}
void TabObserver::OnRendererResponsive(content::RenderProcessHost* process) {
  if (web_contents() &&
      web_contents()->GetPrimaryMainFrame()->GetProcess() == process)
    Emit("onResponsive", base::DictValue());
}
void TabObserver::DidToggleFullscreenModeForTab(bool fullscreen,
                                                bool will_resize) {
  Emit("onFullscreen", base::DictValue().Set("fullscreen", fullscreen));
}
void TabObserver::OnWebContentsFocused(content::RenderWidgetHost* widget) {
  Emit("onPageFocus", base::DictValue());
}
void TabObserver::OnAudioStateChanged(bool) {
  Media();
}
void TabObserver::DidUpdateAudioMutingState(bool) {
  Media();
}
void TabObserver::Media() {
  if (CanEmit())
    Emit("onMedia", base::DictValue()
                        .Set("playing", web_contents()->IsCurrentlyAudible())
                        .Set("muted", web_contents()->IsAudioMuted()));
}
void TabObserver::WebContentsDestroyed() {
  favicon_observation_.Reset();
  find_observation_.Reset();
  zoom_observation_.Reset();
  if (host_ && TabBroker::Get().IsLastLease(web_contents(), lease_))
    host_->ViewEvent(tag_, "onWindowClose", base::DictValue());
}
}  // namespace bay
