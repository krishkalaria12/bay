// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_PAGE_OBSERVER_H_
#define CHROME_BROWSER_BAY_WEBUI_PAGE_OBSERVER_H_

#include <cstdint>
#include <optional>
#include <string>

#include "base/memory/weak_ptr.h"
#include "content/public/browser/web_contents_observer.h"

namespace bay {
class NativeHost;

// A page belongs to one renderer view only while its broker lease is current.
// Transfer keeps the WebContents alive, but invalidates its previous observer.
class TabObserver final : public content::WebContentsObserver {
 public:
  TabObserver(content::WebContents* contents,
              int tag,
              uint64_t lease,
              std::optional<std::string> requested_url,
              base::WeakPtr<NativeHost> host);
  ~TabObserver() override;
  content::WebContents* contents() const;
  uint64_t lease() const;
  const std::optional<std::string>& requested_url() const;
  void set_requested_url(std::optional<std::string> url);
  bool current() const;
  void State();
  void Media();

 private:
  void TitleWasSet(content::NavigationEntry*) override;
  void DidStartLoading() override;
  void DidStopLoading() override;
  void DidFinishNavigation(content::NavigationHandle* handle) override;
  void OnAudioStateChanged(bool) override;
  void DidUpdateAudioMutingState(bool) override;
  void WebContentsDestroyed() override;

  int tag_;
  uint64_t lease_;
  std::optional<std::string> requested_url_;
  base::WeakPtr<NativeHost> host_;
};
}  // namespace bay
#endif
