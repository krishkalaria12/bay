// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_PAGE_OBSERVER_H_
#define CHROME_BROWSER_BAY_WEBUI_PAGE_OBSERVER_H_

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/scoped_observation.h"
#include "base/values.h"
#include "components/favicon/core/favicon_driver_observer.h"
#include "components/find_in_page/find_result_observer.h"
#include "components/zoom/zoom_observer.h"
#include "content/public/browser/web_contents_observer.h"

namespace bay {
class NativeHost;

// View observers follow a mount lease. Broker-owned fact observers follow the
// WebContents through parking and transfers without retaining a renderer host.
class TabObserver final : public content::WebContentsObserver,
                          public favicon::FaviconDriverObserver,
                          public find_in_page::FindResultObserver,
                          public zoom::ZoomObserver {
 public:
  TabObserver(content::WebContents* contents,
              int tag,
              uint64_t lease,
              std::optional<std::string> requested_url,
              base::WeakPtr<NativeHost> host);
  using FactCallback =
      base::RepeatingCallback<void(const char*, base::DictValue)>;
  TabObserver(content::WebContents* contents, FactCallback facts);
  ~TabObserver() override;
  content::WebContents* contents() const;
  uint64_t lease() const;
  const std::optional<std::string>& requested_url() const;
  void set_requested_url(std::optional<std::string> url);
  bool current() const;
  void State();
  void Media();

 private:
  bool CanEmit() const;
  void Emit(const char* event, base::DictValue payload);
  void EnsureObservers();
  base::DictValue NavigationState(const GURL& url) const;
  void Favicon();
  void Zoom();
  void Security();
  void LoadError(const GURL& url, int code);

  void TitleWasSet(content::NavigationEntry*) override;
  void DidStartLoading() override;
  void DidStopLoading() override;
  void LoadProgressChanged(double progress) override;
  void DidStartNavigation(content::NavigationHandle* handle) override;
  void DidFinishNavigation(content::NavigationHandle* handle) override;
  void DidFailLoad(content::RenderFrameHost* frame,
                   const GURL& url,
                   int error_code) override;
  void DidChangeThemeColor() override;
  void OnBackgroundColorChanged() override;
  void DidChangeVisibleSecurityState() override;
  void DidUpdateFaviconURL(
      content::RenderFrameHost* frame,
      const std::vector<blink::mojom::FaviconURLPtr>& candidates,
      blink::mojom::FaviconUpdateReason reason) override;
  void OnFaviconUpdated(favicon::FaviconDriver* driver,
                        NotificationIconType icon_type,
                        const GURL& icon_url,
                        bool icon_url_changed,
                        const gfx::Image& image) override;
  void OnFindResultAvailable(content::WebContents* contents) override;
  void OnFindEmptyText(content::WebContents* contents) override;
  void OnFindTabHelperDestroyed(find_in_page::FindTabHelper* helper) override;
  void OnZoomChanged(
      const zoom::ZoomController::ZoomChangedEventData& data) override;
  void OnZoomControllerDestroyed(zoom::ZoomController* controller) override;
  void OnPageScaleFactorChanged(float scale) override;
  void PrimaryMainFrameRenderProcessGone(
      base::TerminationStatus status) override;
  void OnRendererUnresponsive(content::RenderProcessHost* process) override;
  void OnRendererResponsive(content::RenderProcessHost* process) override;
  void DidToggleFullscreenModeForTab(bool fullscreen,
                                     bool will_resize) override;
  void OnWebContentsFocused(content::RenderWidgetHost* widget) override;
  void OnAudioStateChanged(bool) override;
  void DidUpdateAudioMutingState(bool) override;
  void WebContentsDestroyed() override;

  int tag_ = 0;
  uint64_t lease_ = 0;
  FactCallback facts_;
  std::optional<std::string> requested_url_;
  base::WeakPtr<NativeHost> host_;
  base::ScopedObservation<favicon::FaviconDriver,
                          favicon::FaviconDriverObserver>
      favicon_observation_{this};
  base::ScopedObservation<find_in_page::FindTabHelper,
                          find_in_page::FindResultObserver>
      find_observation_{this};
  base::ScopedObservation<zoom::ZoomController, zoom::ZoomObserver>
      zoom_observation_{this};
  bool initial_state_sent_ = false;
  bool crashed_ = false;
  double pinch_scale_ = 1;
  std::optional<base::DictValue> last_security_;
  std::optional<std::pair<std::string, int>> last_load_error_;
};
}  // namespace bay
#endif
